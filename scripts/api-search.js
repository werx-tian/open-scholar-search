#!/usr/bin/env node
/**
 * api-search.js — 通过开放 API 检索学术文献（无需机构授权）
 *
 * 零依赖：只用 Node 18+ 内置 fetch。
 * 输出 JSONL，可直接交给 oa-resolve.js 与 cnki-export.js 继续处理。
 *
 * 支持的源：
 *   openalex    全学科开放元数据索引（推荐首选，含 OA 链接、引用数、概念标签）
 *   crossref    DOI 注册机构元数据（题录最权威，摘要覆盖不全）
 *   europepmc   生物医学 / 生命科学 + OA 全文直链（水产营养强相关，摘要覆盖好）
 *   pubmed      MEDLINE，支持 MeSH 与字段限定（精确检索强，故与 europepmc 互补）
 *   doaj        开放获取期刊目录（全部为 OA，天然适合全文获取）
 *   arxiv       预印本（物理/数学/CS/量化生物，偶有水产养殖论文）
 *   core        全球机构知识库开放全文聚合
 *
 * 用法：
 *   node api-search.js --query "feeding frequency grass carp" --source openalex,europepmc --limit 20 --out hits.jsonl
 *
 * 参数：
 *   --query <str>      检索词，可重复传入以批量执行
 *   --queries <file>   每行一条检索词的文件（# 为注释）
 *   --synonyms <file> 同义词 JSON；中文种子词同时生成英文对照检索式
 *   --expand <file>   分层检索配置；按层执行并写入 expansionLevel
 *   --source <list>    逗号分隔的源名，或 all，默认 openalex,crossref,europepmc
 *   --limit <n>        每个源每条的取回条数，默认 20（各源上限自动收敛）
 *   --year-from <yyyy> 起始年
 *   --year-to <yyyy>   截止年
 *   --oa-only          只要开放获取的记录
 *   --out <file>       输出 JSONL（追加），默认 api-hits.jsonl；"-" 输出到 stdout
 *   --email <addr>     联系邮箱，进入 OpenAlex/Crossref/Unpaywall 的 polite pool，强烈建议填
 *   --core-key <key>   CORE API key（不填也能返回结果，但官方要求注册，见 references/open-apis.md）
 *   --delay <ms>       请求间隔，默认 400，防止触发限流
 *   --timeout <ms>     单请求超时，默认 25000
 *   --no-append        覆盖而不是追加输出文件
 *   --help
 *
 * 示例：
 *   # 中文课题找外文对照文献，并只保留能拿到全文的
 *   node api-search.js --query "feeding frequency grass carp" --source openalex,europepmc,doaj \
 *     --year-from 2020 --oa-only --limit 30 --email you@example.com --out hits.jsonl
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, runMain } = require('./lib/args');
const { createJsonlWriter, warningRecord, ensureParent } = require('./lib/jsonl');
const { sleep, getJSON: httpJSON } = require('./lib/http');

const SOURCES = ['openalex', 'crossref', 'europepmc', 'pubmed', 'doaj', 'arxiv', 'core'];
const DEFAULT_SOURCES = ['openalex', 'crossref', 'europepmc'];
const RANKED_SOURCES = new Set(['openalex', 'europepmc']);

/* ------------------------------------------------------------------ *
 * 参数
 * ------------------------------------------------------------------ */

const ARG_SPEC = {
  '--query': { key: 'query', type: 'value', multiple: true, default: [] },
  '-q': { key: 'query', type: 'value', multiple: true },
  '--queries': { key: 'queries', type: 'value', multiple: true, default: [] },
  '--synonyms': { key: 'synonyms' },
  '--expand': { key: 'expand' },
  '--source': { key: 'sourceText', default: DEFAULT_SOURCES.join(',') },
  '-s': { key: 'sourceText' },
  '--limit': { key: 'limit', type: 'number', integer: true, min: 1, max: 1000, default: 20 },
  '-n': { key: 'limit', type: 'number', integer: true, min: 1, max: 1000 },
  '--year-from': { key: 'yearFrom', type: 'number', integer: true, min: 1800, max: 2200, default: 0 },
  '--year-to': { key: 'yearTo', type: 'number', integer: true, min: 1800, max: 2200, default: 0 },
  '--oa-only': { key: 'oaOnly', type: 'boolean', default: false },
  '--scope': { key: 'scope', choices: ['auto', 'all', 'title-abs', 'title'], default: 'auto' },
  '--keep-noise': { key: 'keepNoise', type: 'boolean', default: false },
  '--out': { key: 'out', default: 'api-hits.jsonl' },
  '-o': { key: 'out' },
  '--email': { key: 'email', default: '' },
  '--core-key': { key: 'coreKey', default: process.env.CORE_API_KEY || '' },
  '--delay': { key: 'delay', type: 'number', integer: true, min: 0, default: 400 },
  '--timeout': { key: 'timeout', type: 'number', integer: true, min: 1000, default: 25000 },
  '--retries': { key: 'retries', type: 'number', integer: true, min: 0, max: 5, default: 2 },
  '--no-append': { key: 'append', type: 'boolean' },
  '--help': { key: 'help', type: 'boolean', default: false },
  '-h': { key: 'help', type: 'boolean' }
};

function parseCli(argv) {
  const { options: o } = parseArgs(argv, ARG_SPEC, { append: true, help: false });
  o.source = o.sourceText.toLowerCase() === 'all'
    ? SOURCES.slice()
    : o.sourceText.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bad = o.source.filter((s) => !SOURCES.includes(s));
  if (bad.length) { console.error('不支持的源: ' + bad.join(', ') + '\n可选: ' + SOURCES.join(', ')); process.exit(2); }
  return o;
}

const HELP = `api-search.js — 开放 API 多源文献检索

  node api-search.js --query "<检索词>" [options]

  -q, --query <str>     检索词，可重复
      --queries <file>  每行一条检索词的文件
      --synonyms <file> 同义词 JSON；中英文检索式分别执行
      --expand <file>   分层检索 JSON；每层独立执行并标注 expansionLevel
  -s, --source <list>   逗号分隔，或 all
                        可选: openalex crossref europepmc pubmed doaj arxiv core
                        默认: ${DEFAULT_SOURCES.join(',')}
  -n, --limit <n>       每源取回条数，默认 20
      --year-from <yyyy> / --year-to <yyyy>
      --oa-only         只保留开放获取记录
      --scope <mode>    字段范围：auto(默认) | all | title-abs | title
                        auto = europepmc/pubmed 收敛到题名+摘要（默认全字段精度很差）
      --keep-noise      保留图片/表格等非论文条目（默认剔除）
  -o, --out <file>      JSONL 输出（追加），默认 api-hits.jsonl，"-" 为 stdout
      --email <addr>    polite pool 邮箱，强烈建议填
      --core-key <key>  CORE API key
      --delay <ms>      请求间隔，默认 400
      --timeout <ms>    单请求超时，默认 25000
      --retries <n>     超时/429/5xx 重试次数，默认 2
      --no-append       覆盖输出文件

输出可直接串联：
  node cnki-export.js -i api-hits.jsonl -o 清单.csv --format csv
`;

/* ------------------------------------------------------------------ *
 * 公共工具
 * ------------------------------------------------------------------ */

const isCJK = (s) => /[\u4e00-\u9fa5]/.test(s);

function clean(s) {
  return String(s == null ? '' : s)
    .replace(/<[^>]*>/g, ' ')          // 去 JATS / HTML 标签
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}
const oneLine = (s) => clean(s);

function yearOf(v) {
  const m = String(v == null ? '' : v).match(/\b(1[89]\d{2}|20\d{2})\b/);
  return m ? m[1] : '';
}

/** 带重试与限流退避的 GET */
async function getJSON(url, opt, label) {
  return httpJSON(url, opt, label);
}

function yearOk(y, opt) {
  if (!y) return true;
  const n = parseInt(y, 10);
  if (opt.yearFrom && n < opt.yearFrom) return false;
  if (opt.yearTo && n > opt.yearTo) return false;
  return true;
}

function baseRecord(extra) {
  return Object.assign({
    title: '', authors: [], journal: '', year: '', volume: '', issue: '', pages: '',
    doi: '', keywords: [], abstract: '', url: '', sourceUrl: '',
    source: '', sourceId: '', language: '', type: '', citations: null,
    isOA: false, oaStatus: '', oaUrl: '', pdfUrl: '',
    expansionLevel: 0, expansionLevels: [0]
  }, extra);
}

/** 判断用户是否传入了「检索语法」（字段前缀、布尔算子、引号短语），是则原样透传 */
function isRawQuery(q) {
  return /[:()[\]"]/.test(q) || /\s(AND|OR|NOT|ANDNOT)\s/i.test(q);
}

/**
 * 各源对「自然语言式检索词」的接受程度差别很大，需要按源归一化：
 *   - OpenAlex / Crossref / Europe PMC / CORE：直接用自然语言，语义检索效果好
 *   - DOAJ：走 Elasticsearch query_string，多个词必须显式 AND，否则按短语匹配
 *   - arXiv：必须带字段前缀（all:/ti:/abs:），多词要显式 AND，整句短语几乎必然 0 命中
 */
function normalizeQuery(source, query) {
  if (isRawQuery(query)) return query;
  const terms = query.split(/\s+/).filter(Boolean);
  if (terms.length <= 1) return query;
  if (source === 'doaj') return terms.join(' AND ');
  if (source === 'arxiv') return terms.map((t) => 'all:' + t).join(' AND ');
  return query;
}

/**
 * 噪声过滤。
 * Crossref 会把论文内部的图片、表格作为独立 DOI 注册（PeerJ 尤其多），
 * 检索结果里会出现 "Figure 1: xxx"、"Table 2: xxx" 这类条目；
 * 另有 peer-review / dataset / erratum 等非论文条目。统一剔除。
 */
const NOISE_TITLE = /^\s*(fig(ure)?s?|table|scheme|chart|supplement(ary)?|appendix|image)\s*[.\d:：\-–]/i;
const NOISE_TYPE = new Set(['component', 'peer-review', 'dataset', 'grant', 'erratum', 'correction', 'retraction', 'figure', 'table']);

function isNoise(rec) {
  if (!rec.title) return true;
  if (NOISE_TITLE.test(rec.title)) return true;
  if (NOISE_TYPE.has(String(rec.type || '').toLowerCase())) return true;
  return false;
}

/**
 * 字段范围。
 * Europe PMC / PubMed 默认在整个记录（含全文）里做宽松匹配，"feeding frequency grass carp"
 * 会命中《Circulation》心血管病综述、肝吸虫论文之类的无关文献，精度很差；
 * 收敛到题名+摘要后精度显著提升。OpenAlex 也提供 title_and_abstract.search 与之对应。
 *   auto      默认：openalex/crossref 用全字段，europepmc/pubmed 收敛到题名+摘要
 *   all       所有源都用各自最宽泛的字段
 *   title-abs 题名+摘要
 *   title     仅题名（最严格，适合找特定主题的专门研究）
 */
function resolveScope(source, opt) {
  if (opt.scope !== 'auto') return opt.scope;
  // europepmc / pubmed / core 的全字段检索都过于宽松（core 更是整个机构库全文），
  // 实测同一检索词在 core 全字段下会返回声学、渔业政策等无关文献，故默认收敛
  if (source === 'europepmc' || source === 'pubmed' || source === 'core') return 'title-abs';
  return 'all';
}

/** Europe PMC / PubMed 的字段限定语法 */
function scopeTerms(source, query, scope) {
  const terms = query.split(/\s+/).filter(Boolean);
  if (!terms.length) return query;
  if (scope === 'title-abs') {
    return source === 'europepmc'
      ? terms.map((t) => 'TITLE_ABS:' + t).join(' AND ')
      : terms.map((t) => t + '[Title/Abstract]').join(' AND ');
  }
  if (scope === 'title') {
    return source === 'europepmc'
      ? terms.map((t) => 'TITLE:' + t).join(' AND ')
      : terms.map((t) => t + '[Title]').join(' AND ');
  }
  return query;
}

/**
 * PubMed 摘要补充。
 * esummary（JSON）不返回摘要，只有 efetch（XML）才有。这里按 100 个 PMID 分批取回，
 * 用正则解析 —— 依赖 Node 内置能力、不引入 XML 解析库，字段路径稳定且可容错。
 * 返回 { pmid: { abstract, keywords[], authors[], journal } }
 */
async function pubmedEfetch(pmids, opt) {
  const map = {};
  const ids = Array.from(new Set(pmids.filter(Boolean)));
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const p = new URLSearchParams({ db: 'pubmed', id: chunk.join(','), retmode: 'xml' });
    if (opt.email) p.set('email', opt.email);
    const r = await getJSON(`${C.pubmedEf}?${p}`, opt, 'PubMed efetch');
    if (!r.ok) continue;
    for (const block of r.body.split(/<PubmedArticle>/).slice(1)) {
      const pmid = (block.match(/<PMID[^>]*>(\d+)<\/PMID>/) || [, ''])[1];
      if (!pmid) continue;
      const texts = [];
      const re = /<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g;
      let m;
      while ((m = re.exec(block)) !== null) {
        const label = (m[1].match(/Label="([^"]+)"/) || [, ''])[1];
        texts.push((label ? label + ': ' : '') + clean(m[2]));
      }
      const kws = [];
      const kre = /<Keyword[^>]*>([\s\S]*?)<\/Keyword>/g;
      while ((m = kre.exec(block)) !== null) kws.push(clean(m[1]));
      const names = [];
      const are = /<Author[^>]*>([\s\S]*?)<\/Author>/g;
      while ((m = are.exec(block)) !== null) {
        const col = (m[1].match(/<CollectiveName[^>]*>([\s\S]*?)<\/CollectiveName>/) || [, ''])[1];
        if (col) { names.push(clean(col)); continue; }
        const ln = (m[1].match(/<LastName[^>]*>([\s\S]*?)<\/LastName>/) || [, ''])[1];
        const fn = (m[1].match(/<ForeName[^>]*>([\s\S]*?)<\/ForeName>/) || [, ''])[1];
        const nm = [clean(fn), clean(ln)].filter(Boolean).join(' ');
        if (nm) names.push(nm);
      }
      const jt = (block.match(/<Journal>[\s\S]*?<Title[^>]*>([\s\S]*?)<\/Title>/) || [, ''])[1];
      map[pmid] = {
        abstract: texts.join(' ').trim(),
        keywords: Array.from(new Set(kws.filter(Boolean))),
        authors: names,
        journal: clean(jt)
      };
    }
    if (i + 100 < ids.length) await sleep(400);
  }
  return map;
}

/**
 * 各源的强制最小请求间隔（毫秒）。
 * 实测依据：
 *   core   连续两次请求即返回 429，必须放慢
 *   arxiv  官方明确要求间隔 3 秒，否则会被暂停访问
 *   pubmed 无官方间隔要求，但批量 efetch 时不宜密集
 */
const MIN_DELAY = { core: 2500, arxiv: 3000, pubmed: 800 };

/* ------------------------------------------------------------------ *
 * 各源适配器：签名统一为 (query, opt) => Promise<record[]>
 * ------------------------------------------------------------------ */

const C = {
  openalex: 'https://api.openalex.org/works',
  crossref: 'https://api.crossref.org/works',
  europepmc: 'https://www.ebi.ac.uk/europepmc/webservices/rest/search',
  pubmedEs: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi',
  pubmedSum: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi',
  pubmedEf: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi',
  doaj: 'https://doaj.org/api/search/articles/',
  arxiv: 'https://export.arxiv.org/api/query',
  core: 'https://api.core.ac.uk/v3/search/works'
};

/** OpenAlex 的摘要以倒排索引存储，需要还原成正常语序 */
function restoreInverted(inv) {
  if (!inv || typeof inv !== 'object') return '';
  const arr = [];
  for (const [word, poses] of Object.entries(inv)) {
    if (!Array.isArray(poses)) continue;
    for (const p of poses) arr[p] = word;
  }
  return arr.filter(Boolean).join(' ').trim();
}

const adapters = {

  async openalex(query, opt) {
    const scope = resolveScope('openalex', opt);
    const q = normalizeQuery('openalex', query);
    const p = new URLSearchParams({ 'per-page': String(Math.min(opt.limit, 200)), page: '1' });
    if (opt.email) p.set('mailto', opt.email);

    const filters = [];
    if (scope === 'all') p.set('search', q);
    else if (scope === 'title-abs') filters.push('title_and_abstract.search:' + q);
    else filters.push('title.search:' + q);

    if (opt.oaOnly) filters.push('is_oa:true');
    if (opt.minCitations) filters.push('cited_by_count:>' + Math.max(0, opt.minCitations - 1));
    if (opt.yearFrom) filters.push('from_publication_date:' + opt.yearFrom + '-01-01');
    if (opt.yearTo) filters.push('to_publication_date:' + opt.yearTo + '-12-31');
    if (filters.length) p.set('filter', filters.join(','));
    if (opt.highCited) p.set('sort', 'cited_by_count:desc');
    p.set('select', [
      'id', 'doi', 'display_name', 'authorships', 'primary_location', 'biblio',
      'open_access', 'best_oa_location', 'publication_year', 'keywords',
      'abstract_inverted_index', 'type', 'language', 'cited_by_count', 'concepts'
    ].join(','));
    const r = await getJSON(`${C.openalex}?${p}`, opt, 'OpenAlex');
    if (!r.ok) return { error: r.error };
    const j = JSON.parse(r.body);
    const out = [];
    for (const w of (j.results || [])) {
      const loc = w.primary_location || {};
      const src = loc.source || {};
      const bib = w.biblio || {};
      const oa = w.open_access || {};
      const best = w.best_oa_location || {};
      let pages = '';
      if (bib.first_page && bib.last_page) pages = bib.first_page === bib.last_page ? bib.first_page : bib.first_page + '-' + bib.last_page;
      else if (bib.first_page) pages = bib.first_page;
      const rec = baseRecord({
        title: oneLine(w.display_name || w.title || ''),
        authors: (w.authorships || []).map((a) => oneLine(a.author && a.author.display_name)).filter(Boolean),
        journal: oneLine(src.display_name || ''),
        year: String(w.publication_year || ''),
        volume: oneLine(bib.volume || ''),
        issue: oneLine(bib.issue || ''),
        pages,
        doi: (w.doi || '').replace(/^https?:\/\/doi\.org\//i, ''),
        keywords: (w.keywords || []).map((k) => oneLine(k.display_name)).filter(Boolean).slice(0, 12),
        abstract: clean(restoreInverted(w.abstract_inverted_index)),
        source: 'OpenAlex',
        sourceId: w.id || '',
        type: w.type || '',
        language: w.language || '',
        citations: typeof w.cited_by_count === 'number' ? w.cited_by_count : null,
        isOA: !!oa.is_oa,
        oaStatus: oa.oa_status || '',
        oaUrl: best.landing_page_url || oa.oa_url || '',
        pdfUrl: best.pdf_url || ''
      });
      // 概念标签作为补充关键词
      if (rec.keywords.length < 6) {
        const extra = (w.concepts || []).slice(0, 6).map((c) => oneLine(c.display_name)).filter(Boolean);
        rec.keywords = Array.from(new Set(rec.keywords.concat(extra))).slice(0, 12);
      }
      rec.url = rec.oaUrl || loc.landing_page_url || (rec.doi ? 'https://doi.org/' + rec.doi : '');
      rec.sourceUrl = rec.url;
      if (yearOk(rec.year, opt)) out.push(rec);
    }
    return { records: out, total: j.meta && j.meta.count };
  },

  async crossref(query, opt) {
    const filters = [];
    if (opt.yearFrom) filters.push('from-pub-date:' + opt.yearFrom + '-01-01');
    if (opt.yearTo) filters.push('until-pub-date:' + opt.yearTo + '-12-31');
    // 不传 select：Crossref 的 select 白名单会随字段调整而变化，实测传 language 会整体 400。
    // 拿全量 payload 更稳，单页最多 1000 条也扛得住。
    // Crossref 无摘要检索字段，scope 只能落到 query.title 或默认的 query.bibliographic。
    const q = normalizeQuery('crossref', query);
    const p = new URLSearchParams({ rows: String(Math.min(opt.limit, 1000)) });
    if (resolveScope('crossref', opt) === 'title') p.set('query.title', q);
    else p.set('query.bibliographic', q);
    if (filters.length) p.set('filter', filters.join(','));
    if (opt.email) p.set('mailto', opt.email);
    const r = await getJSON(`${C.crossref}?${p}`, opt, 'Crossref');
    if (!r.ok) return { error: r.error };
    const j = JSON.parse(r.body);
    const items = (j.message && j.message.items) || [];
    const out = [];
    for (const w of items) {
      // Crossref 的日期字段名是 `date-parts`（带连字符），不是 `dateparts`。
      // 实测写成 dateparts 会让 year 恒为空字符串，直接影响年份统计与筛选。
      const dp = (((w.issued || w.published || {})['date-parts'] || [[]])[0]) || [];
      const rec = baseRecord({
        title: oneLine((w.title || [])[0] || ''),
        authors: (w.author || []).map((a) => oneLine([a.given, a.family].filter(Boolean).join(' ') || a.name || '')).filter(Boolean),
        journal: oneLine((w['container-title'] || [])[0] || ''),
        year: dp[0] ? String(dp[0]) : '',
        volume: oneLine(w.volume || ''),
        issue: oneLine(w.issue || ''),
        pages: oneLine(String(w.page || '').replace(/[–—]/g, '-')),
        doi: w.DOI || '',
        keywords: (w.subject || []).map(oneLine).filter(Boolean).slice(0, 12),
        abstract: clean(w.abstract || ''),
        source: 'Crossref',
        sourceId: w.DOI || '',
        type: w.type || '',
        language: w.language || '',
        citations: typeof w['is-referenced-by-count'] === 'number' ? w['is-referenced-by-count'] : null
      });
      // Crossref 的 link 字段只是「出版商全文地址」，绝大多数仍需订阅，
      // 不能据此判定开放获取。这里仅作为线索保留，是否真能免费读到交给 oa-resolve.js
      // 通过 OpenAlex / Unpaywall 判定（那两者才有权威的 OA 状态）。
      const links = Array.isArray(w.link) ? w.link : [];
      const pdf = links.find((l) => /pdf/i.test(l['content-type'] || ''));
      const html = links.find((l) => /html|xml/i.test(l['content-type'] || ''));
      rec.publisherLink = (pdf || html || {}).URL || '';
      rec.isOA = false;
      rec.oaStatus = '';
      rec.url = w.URL || (rec.doi ? 'https://doi.org/' + rec.doi : '');
      rec.sourceUrl = rec.url;
      if (opt.oaOnly) continue;
      if (yearOk(rec.year, opt)) out.push(rec);
    }
    return { records: out, total: j.message && j.message['total-results'] };
  },

  async europepmc(query, opt) {
    const scope = resolveScope('europepmc', opt);
    const raw = normalizeQuery('europepmc', query);
    // 用户显式写了检索语法（引号/布尔/字段前缀）时不改写，尊重其意图
    let q = (scope !== 'all' && !isRawQuery(query))
      ? '(' + scopeTerms('europepmc', raw, scope) + ')'
      : raw;
    if (opt.oaOnly) q = `(${q}) AND OPEN_ACCESS:Y`;
    if (opt.yearFrom || opt.yearTo) {
      q += ` AND (PUB_YEAR:[${opt.yearFrom || 1800} TO ${opt.yearTo || new Date().getFullYear() + 1}])`;
    }
    const p = new URLSearchParams({
      query: q, format: 'json', resultType: 'core',
      pageSize: String(Math.min(opt.limit, 1000)),
      sort: 'CITED desc'
    });
    const r = await getJSON(`${C.europepmc}?${p}`, opt, 'Europe PMC');
    if (!r.ok) return { error: r.error };
    const j = JSON.parse(r.body);
    const out = [];
    for (const w of ((j.resultList && j.resultList.result) || [])) {
      const ji = w.journalInfo || {};
      const jr = ji.journal || {};
      const urls = ((w.fullTextUrlList || {}).fullTextUrl || []);
      const pdf = urls.find((u) => u.documentStyle === 'pdf' && u.availability !== 'Subscription');
      const html = urls.find((u) => u.documentStyle === 'html' && u.availability !== 'Subscription');
      const pmcid = w.pmcid || '';
      const rec = baseRecord({
        title: oneLine(w.title || ''),
        authors: oneLine(w.authorString || '').split(/[,;]\s*/).map(oneLine).filter(Boolean),
        journal: oneLine(jr.title || ji.journalIssue && ji.journalIssue.title || ''),
        year: String(w.pubYear || ji.yearOfPublication || ''),
        volume: oneLine(ji.volume || ''),
        issue: oneLine(ji.issue || ''),
        pages: oneLine(w.pageInfo || ''),
        doi: w.doi || '',
        keywords: String(w.keywordList || '').split(/[,;]\s*/).map(oneLine).filter(Boolean),
        abstract: clean(w.abstractText || ''),
        source: 'Europe PMC',
        sourceId: pmcid || w.pmid || w.id || '',
        type: w.pubType || '',
        language: w.language || '',
        citations: w.citedByCount != null ? w.citedByCount : null,
        isOA: w.isOpenAccess === 'Y',
        oaStatus: w.isOpenAccess === 'Y' ? (w.inEPMC === 'Y' ? 'fulltext-in-epmc' : 'free') : 'closed',
        oaUrl: html ? html.url : (pmcid ? 'https://www.ncbi.nlm.nih.gov/pmc/articles/' + pmcid + '/' : ''),
        pdfUrl: pdf ? pdf.url : (pmcid ? 'https://www.ncbi.nlm.nih.gov/pmc/articles/' + pmcid + '/pdf/' : '')
      });
      // 有 PMCID 就意味着 PMC 里有免费全文——此时即便 isOpenAccess 标 N 也应视为可获取，
      // 否则会出现 isOA=true 却 oaStatus=closed 的自相矛盾
      if (pmcid) {
        rec.isOA = true;
        rec.pmcid = pmcid;
        if (rec.oaStatus === 'closed' || !rec.oaStatus) rec.oaStatus = 'pmc-fulltext';
        if (!rec.oaUrl) rec.oaUrl = 'https://www.ncbi.nlm.nih.gov/pmc/articles/' + pmcid + '/';
      }
      if (w.pmid) rec.pmid = w.pmid;
      rec.url = rec.oaUrl || (rec.doi ? 'https://doi.org/' + rec.doi : (w.pmid ? 'https://pubmed.ncbi.nlm.nih.gov/' + w.pmid + '/' : ''));
      rec.sourceUrl = rec.url;
      if (yearOk(rec.year, opt)) out.push(rec);
    }
    return { records: out, total: j.hitCount };
  },

  async pubmed(query, opt) {
    const scope = resolveScope('pubmed', opt);
    const raw = normalizeQuery('pubmed', query);
    let term = (scope !== 'all' && !isRawQuery(query))
      ? '(' + scopeTerms('pubmed', raw, scope) + ')'
      : raw;
    if (opt.yearFrom || opt.yearTo) term += ` AND (${opt.yearFrom || 1800}:${opt.yearTo || new Date().getFullYear() + 1}[dp])`;
    const p1 = new URLSearchParams({ db: 'pubmed', term, retmode: 'json', retmax: String(Math.min(opt.limit, 500)), sort: 'relevance' });
    if (opt.email) p1.set('email', opt.email);
    const r1 = await getJSON(`${C.pubmedEs}?${p1}`, opt, 'PubMed esearch');
    if (!r1.ok) return { error: r1.error };
    const j1 = JSON.parse(r1.body);
    const es = j1.esearchresult || {};
    const ids = es.idlist || [];
    if (!ids.length) return { records: [], total: parseInt(es.count || '0', 10) };
    const p2 = new URLSearchParams({ db: 'pubmed', id: ids.join(','), retmode: 'json' });
    if (opt.email) p2.set('email', opt.email);
    const r2 = await getJSON(`${C.pubmedSum}?${p2}`, opt, 'PubMed esummary');
    if (!r2.ok) return { error: r2.error };
    const res = JSON.parse(r2.body).result || {};
    const out = [];
    for (const id of ids) {
      const u = res[id];
      if (!u) continue;
      const aids = u.articleids || [];
      const doi = (aids.find((x) => x.idtype === 'doi') || {}).value || '';
      const pmc = (aids.find((x) => x.idtype === 'pmc') || {}).value || '';
      const rec = baseRecord({
        title: oneLine(u.title || ''),
        authors: (u.authors || []).map((a) => oneLine(a.name)).filter(Boolean),
        journal: oneLine(u.fulljournalname || u.source || ''),
        year: yearOf(u.pubdate || u.epubdate || ''),
        volume: oneLine(u.volume || ''),
        issue: oneLine(u.issue || ''),
        pages: oneLine(u.pages || ''),
        doi,
        keywords: (u.keywords || []).map(oneLine).filter(Boolean),
        abstract: '',
        source: 'PubMed',
        sourceId: id,
        type: (u.pubtype || [])[0] || '',
        language: u.lang ? String(u.lang[0] || '') : '',
        isOA: !!pmc,
        oaStatus: pmc ? 'pmc-fulltext' : 'closed',
        oaUrl: pmc ? 'https://www.ncbi.nlm.nih.gov/pmc/articles/' + pmc + '/' : '',
        pdfUrl: pmc ? 'https://www.ncbi.nlm.nih.gov/pmc/articles/' + pmc + '/pdf/' : ''
      });
      rec.pmid = id;
      if (pmc) rec.pmcid = pmc;
      if (opt.oaOnly && !pmc) continue;
      rec.url = rec.oaUrl || (doi ? 'https://doi.org/' + doi : 'https://pubmed.ncbi.nlm.nih.gov/' + id + '/');
      rec.sourceUrl = rec.url;
      if (yearOk(rec.year, opt)) out.push(rec);
    }
    // esummary 不含摘要，补一次 efetch（XML）取摘要与关键词
    if (out.length) {
      const extra = await pubmedEfetch(out.map((r) => r.pmid), opt);
      for (const rec of out) {
        const e = extra[rec.pmid];
        if (!e) continue;
        if (e.abstract) rec.abstract = e.abstract;
        if (e.keywords.length) rec.keywords = Array.from(new Set(rec.keywords.concat(e.keywords))).slice(0, 20);
        if (e.authors.length) rec.authors = e.authors;
        if (e.journal) rec.journal = e.journal;
      }
    }
    return { records: out, total: parseInt(es.count || '0', 10) };
  },

  async doaj(query, opt) {
    // DOAJ 的检索式放在路径里；支持 bibjson.field:value 与布尔语法
    const q = encodeURIComponent(normalizeQuery('doaj', query));
    const p = new URLSearchParams({ pageSize: String(Math.min(opt.limit, 100)), page: '1' });
    const r = await getJSON(`${C.doaj}${q}?${p}`, opt, 'DOAJ');
    if (!r.ok) return { error: r.error };
    const j = JSON.parse(r.body);
    const out = [];
    for (const item of (j.results || [])) {
      const b = item.bibjson || {};
      const ids = b.identifier || [];
      const doi = (ids.find((x) => x.type === 'doi') || {}).id || '';
      const links = b.link || [];
      const full = links.find((l) => l.type === 'fulltext') || links[0];
      const jr = b.journal || {};
      const volIssue = [jr.volume, jr.number].filter(Boolean);
      const rec = baseRecord({
        title: oneLine(b.title || ''),
        authors: (b.author || []).map((a) => oneLine(a.name)).filter(Boolean),
        journal: oneLine(jr.title || ''),
        year: String(b.year || ''),
        volume: oneLine(jr.volume || ''),
        issue: oneLine(jr.number || ''),
        pages: oneLine((b.start_page && b.end_page) ? b.start_page + '-' + b.end_page : (b.start_page || '')),
        doi,
        keywords: (b.keywords || []).map(oneLine).filter(Boolean),
        abstract: clean(b.abstract || ''),
        source: 'DOAJ',
        sourceId: doi || item.id || '',
        type: 'journal-article',
        language: (b.journal && b.journal.language) ? String(b.journal.language[0] || '') : '',
        isOA: true,
        oaStatus: 'doaj-gold',
        oaUrl: full ? full.url : '',
        pdfUrl: (links.find((l) => l.content_type === 'PDF') || {}).url || ''
      });
      rec.url = rec.oaUrl || (doi ? 'https://doi.org/' + doi : '');
      rec.sourceUrl = rec.url;
      if (yearOk(rec.year, opt)) out.push(rec);
    }
    return { records: out, total: j.total };
  },

  async arxiv(query, opt) {
    // arXiv 检索语法：字段前缀 + AND，整句引号短语几乎必然 0 命中，故由 normalizeQuery 展开
    const p = new URLSearchParams({
      search_query: normalizeQuery('arxiv', query),
      start: '0',
      max_results: String(Math.min(opt.limit, 500)),
      sortBy: 'relevance'
    });
    const r = await getJSON(`${C.arxiv}?${p}`, opt, 'arXiv');
    if (!r.ok) return { error: r.error };
    const xml = r.body;
    const out = [];
    const entries = xml.split(/<entry>/).slice(1);
    for (let e of entries) {
      e = e.split('</entry>')[0];
      const pick = (tag) => {
        const m = e.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>'));
        return m ? clean(m[1]) : '';
      };
      const pickAll = (tag) => {
        const re = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'g');
        const res = []; let m;
        while ((m = re.exec(e)) !== null) res.push(clean(m[1]));
        return res;
      };
      const idUrl = pick('id');
      const arxivId = (idUrl.match(/abs\/(.+)$/) || [, ''])[1];
      const pub = pick('published');
      const doi = (e.match(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/) || [, ''])[1];
      const journalRef = (e.match(/<arxiv:journal_ref[^>]*>([\s\S]*?)<\/arxiv:journal_ref>/) || [, ''])[1];
      const cats = (e.match(/term="([^"]+)"/g) || []).map((s) => s.replace(/term="|"/g, ''));
      const rec = baseRecord({
        title: pick('title'),
        authors: pickAll('name'),
        journal: clean(journalRef) || 'arXiv preprint',
        year: yearOf(pub),
        volume: '', issue: '', pages: '',
        doi: clean(doi),
        keywords: Array.from(new Set(cats)).slice(0, 12),
        abstract: pick('summary'),
        source: 'arXiv',
        sourceId: arxivId,
        type: 'preprint',
        language: 'en',
        isOA: true,
        oaStatus: 'preprint',
        oaUrl: idUrl,
        pdfUrl: idUrl.replace('/abs/', '/pdf/'),
        url: idUrl,
        sourceUrl: idUrl
      });
      if (!rec.doi && arxivId) rec.doi = 'arXiv:' + arxivId.split('v')[0];
      if (yearOk(rec.year, opt)) out.push(rec);
    }
    return { records: out, total: out.length };
  },

  async core(query, opt) {
    // CORE 的 q 默认在整个机构库全文里搜，噪声极大；收敛到题名字段后精度正常。
    // 实测：title:("短语") 会被忽略退化成全字段检索，必须用 title:(a AND b) 形式。
    // 但把 4 个以上检索词全部 AND 进题名会归零，故为零结果时自动放宽到前两个词。
    const scope = resolveScope('core', opt);
    const raw = normalizeQuery('core', query);
    const terms = raw.split(/\s+/).filter(Boolean);
    const titleQuery = (ts) => 'title:(' + ts.join(' AND ') + ')';

    const attempts = [];
    if (scope === 'all' || isRawQuery(query) || terms.length <= 1) attempts.push(raw);
    else {
      attempts.push(titleQuery(terms));
      if (terms.length >= 3) attempts.push(titleQuery(terms.slice(0, 2)));
    }

    for (let a = 0; a < attempts.length; a++) {
      const p = new URLSearchParams({ q: attempts[a], limit: String(Math.min(opt.limit, 100)), offset: '0' });
      const r = await getJSON(`${C.core}?${p}`, opt, 'CORE');
      if (!r.ok) return { error: r.error };
      let j;
      try { j = JSON.parse(r.body); } catch (e) { return { error: 'CORE 返回非 JSON，可能需要 API key' }; }
      if (j.message && /key/i.test(String(j.message))) return { error: 'CORE 要求 API key：' + j.message };

      const out = [];
      for (const w of (j.results || [])) {
        const jr = (w.journals && w.journals[0]) || {};
        const rec = baseRecord({
          title: oneLine(w.title || ''),
          authors: (w.authors || []).map((a2) => oneLine(a2.name)).filter(Boolean),
          journal: oneLine(jr.title || w.publisher || ''),
          year: String(w.yearPublished || ''),
          volume: oneLine(jr.volume || ''),
          issue: oneLine(jr.issue || ''),
          pages: oneLine(jr.pages || ''),
          doi: String(w.doi || '').replace(/^https?:\/\/doi\.org\//i, ''),
          keywords: (w.subjects || []).map((s) => oneLine(typeof s === 'string' ? s : s.name)).filter(Boolean).slice(0, 12),
          abstract: clean(w.abstract || ''),
          source: 'CORE',
          sourceId: String(w.id || ''),
          type: w.documentType || '',
          language: (w.language && w.language.code) || '',
          isOA: true,
          oaStatus: 'repository',
          oaUrl: w.downloadUrl || w.fullTextIdentifier || '',
          pdfUrl: /\.pdf(\?|$)/i.test(w.downloadUrl || '') ? w.downloadUrl : ''
        });
        rec.url = rec.oaUrl || rec.pdfUrl || (rec.doi ? 'https://doi.org/' + rec.doi : '');
        rec.sourceUrl = rec.url;
        if (yearOk(rec.year, opt)) out.push(rec);
      }

      if (out.length || a === attempts.length - 1) {
        return { records: out, total: j.totalHits, relaxed: a > 0 ? attempts[a] : null };
      }
      await sleep(1200);   // 放宽重试前先停一下，CORE 限流很紧
    }
    return { records: [], total: 0 };
  }
};

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function loadQueries(opt) {
  const out = opt.query.slice();
  for (const f of opt.queries) {
    if (!fs.existsSync(f)) { console.error('[search] 找不到检索词文件: ' + f); continue; }
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const s = line.trim();
      if (s && !s.startsWith('#')) out.push(s);
    }
  }
  return out;
}

function readJson(file, label) {
  if (!file) return null;
  if (!fs.existsSync(file)) throw new Error(`${label} 文件不存在: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${label} JSON 解析失败: ${err.message}`);
  }
}

function synonymDictionary(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const source = raw.entries && typeof raw.entries === 'object' ? raw.entries : raw;
  const dictionary = {};
  for (const [canonical, info] of Object.entries(source)) {
    if (!info || typeof info !== 'object') continue;
    dictionary[canonical] = {
      synonyms: Array.isArray(info.synonyms) ? info.synonyms.filter(Boolean).map(String) : [],
      latin: String(info.latin || ''),
      english: String(info.english || '')
    };
  }
  return dictionary;
}

function replaceTerms(query, matches, locale) {
  let output = query;
  const used = new Set();
  for (const match of matches) {
    const terms = locale === 'zh'
      ? [match.canonical, ...match.info.synonyms]
      : [match.info.english, match.info.latin];
    const unique = Array.from(new Set(terms.map((s) => String(s || '').trim()).filter(Boolean)));
    if (!unique.length) continue;
    const replacement = unique.length === 1 ? unique[0] : '(' + unique.join(' OR ') + ')';
    if (output.includes(match.term)) output = output.split(match.term).join(replacement);
    unique.forEach((term) => used.add(term));
  }
  return { query: output, terms: Array.from(used) };
}

function expandSynonyms(query, dictionary) {
  const matches = [];
  for (const [canonical, info] of Object.entries(dictionary)) {
    for (const term of [canonical, info.latin, info.english, ...info.synonyms]) {
      if (term && query.includes(term)) matches.push({ term, canonical, info });
    }
  }
  if (!matches.length) {
    return [{
      query,
      seedQuery: query,
      language: isCJK(query) ? 'zh' : 'en',
      expansionTerms: [],
      queryVariant: 'original'
    }];
  }

  matches.sort((a, b) => b.term.length - a.term.length);
  const zh = replaceTerms(query, matches, 'zh');
  const en = replaceTerms(query, matches, 'en');
  const variants = [];
  const seen = new Set();
  for (const [variant, item] of [['zh-expanded', zh], ['en-expanded', en]]) {
    if (!item.query || seen.has(item.query)) continue;
    seen.add(item.query);
    variants.push({
      query: item.query,
      seedQuery: query,
      language: isCJK(item.query) ? 'zh' : 'en',
      expansionTerms: item.terms,
      queryVariant: variant
    });
  }
  return variants;
}

function expansionLayers(raw, queries, fallbackScope) {
  if (!raw) {
    return [{
      level: 0,
      label: 'L0 直接检索',
      evidenceNature: '本种/本概念的直接证据',
      queries,
      limit: null,
      scope: fallbackScope,
      minCitations: 0
    }];
  }
  const layers = Array.isArray(raw) ? raw : raw.layers;
  if (!Array.isArray(layers) || !layers.length) {
    throw new Error('--expand 文件必须为数组，或包含非空 layers 数组');
  }
  const defaultLimits = { 0: 50, 1: 30, 2: 20, 3: 10 };
  return layers.map((layer, index) => {
    const level = Number.isInteger(layer.level) ? layer.level : index;
    const layerQueries = Array.isArray(layer.queries)
      ? layer.queries.map(String).filter(Boolean)
      : [String(layer.query || '').trim()].filter(Boolean);
    return {
      level,
      label: String(layer.label || `L${level}`),
      evidenceNature: String(layer.evidenceNature || layer.evidence || ''),
      queries: layerQueries.length ? layerQueries : queries,
      limit: Number.isInteger(layer.limit) ? layer.limit : defaultLimits[level],
      scope: layer.scope || fallbackScope,
      minCitations: Math.max(0, Number(layer.minCitations || 0)),
      caution: String(layer.caution || '')
    };
  });
}

runMain(async () => {
  const opt = parseCli(process.argv.slice(2));
  if (opt.help) { console.log(HELP); return; }

  const queries = loadQueries(opt);
  if (!queries.length && !opt.expand) {
    console.error('未指定检索词。用 --query "<词>" 或 --queries <file>。\n');
    console.log(HELP);
    process.exit(2);
  }
  if (!opt.email) {
    console.error('[search] 提示：未提供 --email，OpenAlex / Crossref 会退到公共池，易被限流。建议填邮箱。');
  }

  const synonymRaw = readJson(opt.synonyms, '同义词');
  const dictionary = synonymDictionary(synonymRaw);
  const expandRaw = readJson(opt.expand, '分层检索');
  const layers = expansionLayers(expandRaw, queries, opt.scope);

  if (opt.out !== '-' && !opt.append) {
    ensureParent(opt.out);
    fs.writeFileSync(path.resolve(opt.out), '');
  }
  const writer = createJsonlWriter(opt.out);

  const stats = {};
  let written = 0;
  let noise = 0;
  let warnings = 0;
  const seen = new Set();
  const byLevel = new Map();

  const emit = (rec, task) => {
    if (!opt.keepNoise && isNoise(rec)) { noise++; return false; }
    const level = task.expansionLevel;
    const key = `${level}|${(rec.doi || '').toLowerCase() || rec.title.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    rec.expansionLevel = level;
    rec.expansionLevels = Array.from(new Set([...(rec.expansionLevels || []), level])).sort();
    rec.expansionLabel = task.expansionLabel;
    rec.evidenceNature = task.evidenceNature;
    rec.caution = task.caution || '';
    rec.seedQuery = task.seedQuery;
    rec.query = task.query;
    rec.queryLanguage = task.language;
    rec.queryVariant = task.queryVariant;
    rec.expansionTerms = task.expansionTerms;
    rec.queryScope = task.scope;
    rec.rankedByCitations = RANKED_SOURCES.has(rec.sourceKey) && level >= 2;
    if (task.minCitations) rec.minCitations = task.minCitations;
    writer.write(rec);
    written++;
    byLevel.set(level, (byLevel.get(level) || 0) + 1);
    return true;
  };

  for (const layer of layers) {
    const layerOpt = Object.assign({}, opt, {
      limit: layer.limit || opt.limit,
      scope: layer.scope || opt.scope,
      highCited: layer.level >= 2,
      minCitations: layer.minCitations || 0
    });
    const layerQueries = layer.queries;
    console.error(`\n[search] ${layer.label}（expansionLevel=${layer.level}）`);

    for (const baseQuery of layerQueries) {
      const variants = expandSynonyms(baseQuery, dictionary);
      for (const variant of variants) {
        const task = {
          ...variant,
          expansionLevel: layer.level,
          expansionLabel: layer.label,
          evidenceNature: layer.evidenceNature,
          caution: layer.caution,
          scope: layer.scope || opt.scope,
          minCitations: layer.minCitations || 0
        };
        console.error(`  [${task.language}/${task.queryVariant}] ${task.query}`);
        for (const src of opt.source) {
          const t0 = Date.now();
          let res;
          try { res = await adapters[src](task.query, layerOpt); }
          catch (err) { res = { error: err.message }; }

          if (res.error) {
            console.error(`    ${src.padEnd(11)} 失败: ${res.error}`);
            stats[src] = stats[src] || { ok: 0, err: 0, dup: 0 };
            stats[src].err++;
            const warning = warningRecord(src, res.error, {
              query: task.query,
              expansionLevel: layer.level,
              retries: opt.retries
            });
            warning.expansionLevel = layer.level;
            writer.write(warning);
            warnings++;
          } else {
            let kept = 0, dup = 0;
            for (const rec of res.records) {
              rec.sourceKey = src;
              if (emit(rec, task)) kept++; else dup++;
            }
            const total = res.total != null ? ` / 该源共 ${res.total} 命中` : '';
            const relaxed = res.relaxed ? `  [已自动放宽为 ${res.relaxed}]` : '';
            console.error(`    ${src.padEnd(11)} 取回 ${String(res.records.length).padStart(3)} 条，新增 ${String(kept).padStart(3)} 条${total}  (${Date.now() - t0}ms)${relaxed}`);
            stats[src] = stats[src] || { ok: 0, err: 0, dup: 0 };
            stats[src].ok += kept;
            stats[src].dup += dup;
          }
          await sleep(Math.max(opt.delay, MIN_DELAY[src] || 0));
        }
      }
    }
  }

  await writer.end();

  console.error('\n[search] 汇总');
  for (const [src, s] of Object.entries(stats)) {
    console.error(`  ${src.padEnd(11)} 新增 ${String(s.ok).padStart(4)}  跨源重复 ${String(s.dup).padStart(4)}  失败 ${s.err}`);
  }
  console.error(`  写出记录 ${written} 条`);
  if (byLevel.size) {
    console.error('  按扩展层：' + Array.from(byLevel.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([level, count]) => `L${level}=${count}`).join('，'));
  }
  if (warnings) console.error(`  写入源失败警告 ${warnings} 条（recordType=warning）`);
  if (noise) console.error(`  剔除噪声（图片/表格/勘误等非论文条目）${noise} 条`);
  if (opt.out !== '-') {
    console.error(`  输出文件 ${path.resolve(opt.out)}`);
    console.error(`\n  下一步：node cnki-export.js -i "${opt.out}" -o 文献清单.csv --format csv`);
    console.error(`  取全文：node oa-resolve.js -i "${opt.out}" -o with-oa.jsonl --email <你的邮箱>`);
  }
});
