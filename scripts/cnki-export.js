#!/usr/bin/env node
/**
 * cnki-export.js — 题录去重与多格式导出
 *
 * 零依赖：只用 Node 内置模块。读取 cnki-grab.js 产出的 JSONL（或任意题录 JSON），
 * 归一化字段 → 去重合并 → 导出 csv / tsv / bibtex / markdown / json。
 *
 * 用法：
 *   node cnki-export.js --input records.jsonl --out 文献清单.csv --format csv
 *
 * 参数：
 *   --input <file>   输入文件，支持 .jsonl / .ndjson / .json，可重复或用逗号分隔
 *   --out <file>     输出文件；传 "-" 输出到 stdout，默认 out.csv
 *   --format <fmt>   csv | tsv | bibtex | markdown | json，默认按 --out 后缀推断
 *   --dedup <mode>   doi-title（默认）| doi | title | none
 *   --sort <mode>    none（默认）| expansion | year | year-desc | journal | title
 *   --keep-empty     保留没有题名的记录（默认丢弃，多为抓取失败的残行）
 *   --abstract-len <n>  摘要截断长度，0 表示不截断，默认 0
 *   --no-abstract    导出时省略摘要字段
 *   --detail          markdown 格式下为每条记录附摘要详情块
 *   --help           显示帮助
 *
 * 示例：
 *   node cnki-export.js --input records.jsonl --out 清单.csv --format csv
 *   node cnki-export.js -i records.jsonl -o refs.bib --format bibtex --sort year-desc
 *   node cnki-export.js -i records.jsonl -o 清单.md --format markdown --detail
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, runMain } = require('./lib/args');
const { readRecords, ensureParent } = require('./lib/jsonl');

/* ------------------------------------------------------------------ *
 * 参数解析
 * ------------------------------------------------------------------ */

const ARG_SPEC = {
  '--input': { key: 'input', type: 'csv', multiple: true, default: [] },
  '-i': { key: 'input', type: 'csv', multiple: true },
  '--out': { key: 'out', default: 'out.csv' },
  '-o': { key: 'out' },
  '--format': { key: 'format', choices: ['csv', 'tsv', 'bibtex', 'markdown', 'md', 'json'], default: '' },
  '-f': { key: 'format', choices: ['csv', 'tsv', 'bibtex', 'markdown', 'md', 'json'] },
  '--dedup': { key: 'dedup', choices: ['doi-title', 'doi', 'title', 'none'], default: 'doi-title' },
  '--sort': { key: 'sort', choices: ['none', 'expansion', 'year', 'year-desc', 'journal', 'title'], default: 'none' },
  '--keep-empty': { key: 'keepEmpty', type: 'boolean', default: false },
  '--abstract-len': { key: 'abstractLen', type: 'number', integer: true, min: 0, default: 0 },
  '--no-abstract': { key: 'noAbstract', type: 'boolean', default: false },
  '--detail': { key: 'detail', type: 'boolean', default: false },
  '--help': { key: 'help', type: 'boolean', default: false },
  '-h': { key: 'help', type: 'boolean' }
};

const HELP = `cnki-export.js — 题录去重与多格式导出

  node cnki-export.js --input records.jsonl --out 文献清单.csv --format csv

  -i, --input <file>    输入 .jsonl/.ndjson/.json，可重复或用逗号分隔
  -o, --out <file>      输出文件，"-" 为 stdout，默认 out.csv
  -f, --format <fmt>    csv | tsv | bibtex | markdown | json（默认按后缀推断）
      --dedup <mode>    doi-title(默认) | doi | title | none
      --sort <mode>     none(默认) | expansion | year | year-desc | journal | title
      --keep-empty      保留无题名的记录
      --abstract-len n  摘要截断长度，0 为不截断
      --no-abstract     省略摘要字段
      --detail          markdown 下附摘要详情块
`;

/* ------------------------------------------------------------------ *
 * 字段归一化
 * ------------------------------------------------------------------ */

const ALIAS = {
  title: ['title', '题名', '标题', '篇名', 'name'],
  authors: ['authors', 'author', '作者', 'creators', 'citation_author'],
  journal: ['journal', '期刊', '刊名', '来源', 'sourceTitle', 'citation_journal_title'],
  year: ['year', '年', '出版年', 'publicationDate'],
  volume: ['volume', '卷'],
  issue: ['issue', '期'],
  pages: ['pages', '页码', 'page', 'pageRange', 'page_range'],
  doi: ['doi', 'DOI'],
  keywords: ['keywords', '关键词', '关键字'],
  abstract: ['abstract', '摘要', '中文摘要'],
  abstractEn: ['abstractEn', '英文摘要', 'abstract_en'],
  fund: ['fund', '基金', '基金项目', '资助项目'],
  url: ['sourceUrl', 'url', 'link', '来源URL', 'finalUrl', 'source_url'],
  source: ['source', '来源库', 'database', 'db', 'platform'],
  oaUrl: ['oaUrl', 'openAccessUrl', 'open_access_url'],
  pdfUrl: ['pdfUrl', 'fulltextPdfUrl', 'pdf_url'],
  oaStatus: ['oaStatus', 'openAccessStatus', 'oa_status'],
  isOA: ['isOA', 'openAccess', 'is_oa']
};

/** 质量体检关注的核心字段（与 CORE 数据库无关，避免误读故改名） */
const CORE_FIELDS = ['title', 'authors', 'journal', 'year', 'doi', 'abstract'];

/** 全角转半角 + 压缩空白 */
function toHalf(s) {
  return String(s == null ? '' : s)
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

const oneLine = (s) => toHalf(s).replace(/\s*\n\s*/g, ' ').trim();

function asArray(v) {
  if (Array.isArray(v)) return v.map(oneLine).filter(Boolean);
  if (typeof v === 'string') {
    const half = toHalf(v);
    if (/[;；,，、]/.test(half)) return half.split(/[;；,，、]+/).map(oneLine).filter(Boolean);
    return half ? [oneLine(half)] : [];
  }
  return [];
}

function pick(obj, field) {
  for (const k of ALIAS[field]) {
    if (obj[k] != null && obj[k] !== '') return obj[k];
  }
  return '';
}

function normalize(raw) {
  // Preserve source-specific fields, provenance, warnings, and future extensions.
  const rec = Object.assign({}, raw);
  rec.title = oneLine(pick(raw, 'title'));
  rec.authors = asArray(pick(raw, 'authors'));
  rec.journal = oneLine(pick(raw, 'journal'));
  rec.year = (String(pick(raw, 'year')).match(/\b(1[89]|20)\d{2}\b/) || [''])[0];
  rec.volume = oneLine(pick(raw, 'volume'));
  rec.issue = oneLine(pick(raw, 'issue'));
  let pages = oneLine(pick(raw, 'pages'));
  pages = pages.replace(/[–—~〜]/g, '-').replace(/^[\s:：]+/, '');
  rec.pages = pages;
  let doi = oneLine(pick(raw, 'doi'))
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi[:\s]*/i, '')
    .replace(/[.,;]+$/, '');
  rec.doi = doi;
  rec.keywords = asArray(pick(raw, 'keywords'));
  rec.abstract = toHalf(pick(raw, 'abstract'));
  rec.abstractEn = toHalf(pick(raw, 'abstractEn'));
  rec.fund = oneLine(pick(raw, 'fund'));
  rec.url = oneLine(pick(raw, 'url'));
  rec.source = oneLine(pick(raw, 'source'));
  rec.oaUrl = oneLine(pick(raw, 'oaUrl'));
  rec.pdfUrl = oneLine(pick(raw, 'pdfUrl'));
  rec.oaStatus = oneLine(pick(raw, 'oaStatus'));
  const oaFlag = pick(raw, 'isOA');
  rec.isOA = oaFlag === true || oaFlag === 'true' || oaFlag === 'Y';
  rec.expansionLevel = Number.isInteger(raw.expansionLevel) ? raw.expansionLevel : 0;
  rec.expansionLevels = Array.from(new Set(
    (Array.isArray(raw.expansionLevels) ? raw.expansionLevels : [rec.expansionLevel])
      .map(Number).filter(Number.isInteger)
  )).sort((a, b) => a - b);
  rec.expansionLabel = oneLine(raw.expansionLabel || '');
  rec.evidenceNature = oneLine(raw.evidenceNature || '');
  rec.seedQuery = oneLine(raw.seedQuery || '');
  rec.query = oneLine(raw.query || '');
  rec.queryScope = oneLine(raw.queryScope || '');
  rec.queryVariant = oneLine(raw.queryVariant || '');
  rec.expansionTerms = asArray(raw.expansionTerms || []);
  rec.caution = toHalf(raw.caution || '');
  return rec;
}

const normTitleKey = (t) => toHalf(t)
  .normalize('NFKC')
  .toLowerCase()
  .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ');
const normDoiKey = (d) => String(d || '').toLowerCase().trim();

/* ------------------------------------------------------------------ *
 * 去重
 * ------------------------------------------------------------------ */

/**
 * 去重键集合。
 * 关键设计：同一条记录**同时**注册 DOI 键与题名键，这样"有 DOI 的记录"和
 * "同题名但缺 DOI 的记录"仍然能合并——知网题录的 DOI 覆盖率并不完整，
 * 只按单一首选键去重会留下大量肉眼可见的重复。
 */
function dedupKeys(rec, mode) {
  if (mode === 'none') return [];
  const useDoi = mode === 'doi-title' || mode === 'doi';
  const useTitle = mode === 'doi-title' || mode === 'title';
  const keys = [];
  const doi = normDoiKey(rec.doi);
  const title = normTitleKey(rec.title);
  if (useDoi && doi) keys.push('doi:' + doi);
  if (useTitle && title) keys.push('ti:' + title);
  return keys;
}

function mergeInto(dst, src) {
  for (const f of ['title', 'journal', 'volume', 'issue', 'pages', 'doi', 'fund', 'url', 'year']) {
    if (!dst[f] && src[f]) dst[f] = src[f];
  }
  for (const f of ['authors', 'keywords']) {
    if ((!dst[f] || !dst[f].length) && src[f] && src[f].length) dst[f] = src[f];
  }
  for (const f of ['abstract', 'abstractEn']) {
    const a = dst[f] || '', b = src[f] || '';
    if (b.length > a.length) dst[f] = b;
  }
  dst.expansionLevels = Array.from(new Set([
    ...(dst.expansionLevels || [dst.expansionLevel || 0]),
    ...(src.expansionLevels || [src.expansionLevel || 0])
  ].map(Number).filter(Number.isInteger))).sort((a, b) => a - b);
  dst.expansionLevel = Math.min(
    Number.isInteger(dst.expansionLevel) ? dst.expansionLevel : 99,
    Number.isInteger(src.expansionLevel) ? src.expansionLevel : 99
  );
  if (dst.expansionLevel === 99) dst.expansionLevel = 0;
  if (!dst.evidenceNature && src.evidenceNature) dst.evidenceNature = src.evidenceNature;
  if (!dst.query && src.query) dst.query = src.query;
  if (!dst.seedQuery && src.seedQuery) dst.seedQuery = src.seedQuery;
  if (!dst.caution && src.caution) dst.caution = src.caution;
  if (Array.isArray(src._warnings) && src._warnings.length) {
    const seen = new Set((dst._warnings || []).map((item) => JSON.stringify(item)));
    dst._warnings = (dst._warnings || []).slice();
    for (const warning of src._warnings) {
      const key = JSON.stringify(warning);
      if (!seen.has(key)) {
        seen.add(key);
        dst._warnings.push(warning);
      }
    }
  }
  dst.mergedFrom = (dst.mergedFrom || 1) + 1;
  return dst;
}

function dedup(records, mode) {
  if (mode === 'none') return { list: records.slice(), removed: 0 };

  const keyIndex = new Map();   // 任意键 -> 该键所属的规范记录对象
  const list = [];
  let removed = 0;

  for (const r of records) {
    const keys = dedupKeys(r, mode);
    if (!keys.length) { list.push(r); continue; }

    const targets = Array.from(new Set(keys.map((k) => keyIndex.get(k)).filter(Boolean)));

    if (!targets.length) {
      // 全新记录，把它的所有键都指向自己
      list.push(r);
      for (const k of keys) keyIndex.set(k, r);
      continue;
    }

    // 与已有记录重复，合并进第一个命中者
    const canon = targets[0];
    mergeInto(canon, r);
    removed++;

    // 若该记录的另一个键命中了不同的规范记录，把两者并起来并重指向
    for (const other of targets.slice(1)) {
      if (other === canon) continue;
      mergeInto(canon, other);
      const i = list.indexOf(other);
      if (i >= 0) list.splice(i, 1);
      for (const [k, v] of keyIndex) if (v === other) keyIndex.set(k, canon);
    }
    for (const k of keys) keyIndex.set(k, canon);
  }

  return { list, removed };
}

/* ------------------------------------------------------------------ *
 * CSV / TSV
 * ------------------------------------------------------------------ */

/**
 * 列定义集中在一处，避免表头与取值顺序脱节（早期版本分两处维护，加列时极易错位）。
 * optional 标记的列仅在对应开关打开时输出。
 */
const COLUMNS = [
  { head: '序号', get: (r, i) => String(i + 1) },
  { head: '扩展层级', get: (r) => `L${r.expansionLevel}` },
  { head: '证据性质', get: (r) => r.evidenceNature },
  { head: '来源库', get: (r) => r.source || '' },
  { head: '题名', get: (r) => r.title },
  { head: '作者', get: (r) => r.authors.join('; ') },
  { head: '期刊', get: (r) => r.journal },
  { head: '年', get: (r) => r.year },
  { head: '卷', get: (r) => r.volume },
  { head: '期', get: (r) => r.issue },
  { head: '页码', get: (r) => r.pages },
  { head: 'DOI', get: (r) => r.doi },
  { head: '开放获取', get: (r) => r.oaStatus || (r.isOA ? 'OA' : '') },
  { head: '全文链接', get: (r) => r.pdfUrl || r.oaUrl || '' },
  { head: '关键词', get: (r) => r.keywords.join('; ') },
  { head: '基金', get: (r) => r.fund },
  { head: '摘要', get: (r) => r.abstract, optional: 'abstract' },
  { head: '来源URL', get: (r) => r.url || '' }
];

function csvCell(v, delim) {
  let s = String(v == null ? '' : v);
  if (delim === '\t') return s.replace(/\r?\n/g, ' ').replace(/\t/g, ' ');
  if (/["\n\r]/.test(s) || s.includes(delim)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toDelimited(list, delim, withAbstract) {
  const cols = COLUMNS.filter((c) => !(c.optional === 'abstract' && !withAbstract));
  const lines = [cols.map((c) => c.head).join(delim)];
  list.forEach((r, i) => {
    lines.push(cols.map((c) => csvCell(c.get(r, i), delim)).join(delim));
  });
  return lines.join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------------ *
 * BibTeX
 * ------------------------------------------------------------------ */

const bibEscape = (s) => String(s || '')
  .replace(/\\/g, '\\textbackslash{}')
  .replace(/([&%$#_{}])/g, '\\$1')
  .replace(/~/g, '\\textasciitilde{}')
  .replace(/\^/g, '\\textasciicircum{}');

const asciiSlug = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '');

function bibKey(rec, i) {
  const first = (rec.authors[0] || '').trim();
  let base = '';
  if (first) {
    let surname;
    if (first.includes(',')) {
      // "Zhang, Wei" —— 逗号前是姓
      surname = first.split(',')[0].trim();
    } else {
      // "Wei Zhang" —— 末位是姓；中文姓名取首字
      const parts = first.split(/\s+/).filter(Boolean);
      surname = parts.length > 1 && /^[A-Za-z]/.test(first) ? parts[parts.length - 1] : parts[0];
    }
    base = asciiSlug(surname).slice(0, 12);
  }
  if (!base) base = 'scholar';
  return base + (rec.year || '') + '_' + String(i + 1).padStart(3, '0');
}

function toBibtex(list, withAbstract) {
  return list.map((r, i) => {
    const B = (v) => '{' + v + '}';            // 普通字段
    const fields = [];
    if (r.authors.length) fields.push(['author', B(r.authors.map(bibEscape).join(' and '))]);
    if (r.title) fields.push(['title', '{{' + bibEscape(r.title) + '}}']);   // 双花括号保留大小写
    if (r.journal) fields.push(['journal', B(bibEscape(r.journal))]);
    if (r.year) fields.push(['year', B(r.year)]);
    if (r.volume) fields.push(['volume', B(bibEscape(r.volume))]);
    if (r.issue) fields.push(['number', B(bibEscape(r.issue))]);
    if (r.pages) fields.push(['pages', B(bibEscape(r.pages))]);
    if (r.doi) fields.push(['doi', B(bibEscape(r.doi))]);
    if (r.keywords.length) fields.push(['keywords', B(bibEscape(r.keywords.join(', ')))]);
    if (r.fund) fields.push(['note', B('基金：' + bibEscape(r.fund))]);
    if (r.url) fields.push(['url', B(bibEscape(r.url))]);
    if (withAbstract && r.abstract) fields.push(['abstract', B(bibEscape(r.abstract))]);
    const body = fields.map(([k, v]) => '  ' + k + ' = ' + v).join(',\n');
    return `@article{${bibKey(r, i)},\n${body}\n}`;
  }).join('\n\n') + '\n';
}

/* ------------------------------------------------------------------ *
 * Markdown
 * ------------------------------------------------------------------ */

const mdCell = (s) => String(s == null ? '' : s).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim();

function toMarkdown(list, withAbstract, detail) {
  const out = [];
  out.push(`# 文献清单`);
  out.push('');
  out.push(`共 **${list.length}** 条。`);

  const levels = Array.from(new Set(list.map((r) => r.expansionLevel || 0))).sort((a, b) => a - b);
  const grouped = levels.length > 1 || levels.some((level) => level > 0);
  const table = (rows, offset) => {
    out.push('');
    out.push('| # | 扩展层 | 题名 | 作者 | 期刊 | 年 | 卷(期) | 页码 | DOI | 全文 |');
    out.push('|---|---|---|---|---|---|---|---|---|---|');
    rows.forEach((r, i) => {
      const volIssue = [r.volume, r.issue].filter(Boolean).join('(') + (r.issue ? ')' : '');
      const full = r.pdfUrl ? `[PDF](${r.pdfUrl})` : (r.oaUrl ? `[链接](${r.oaUrl})` : (r.oaStatus ? mdCell(r.oaStatus) : ''));
      out.push(`| ${offset + i + 1} | L${r.expansionLevel} | ${mdCell(r.title)} | ${mdCell(r.authors.join('; '))} | ${mdCell(r.journal)} | ${mdCell(r.year)} | ${mdCell(volIssue)} | ${mdCell(r.pages)} | ${mdCell(r.doi)} | ${full} |`);
    });
  };

  if (grouped) {
    let offset = 0;
    for (const level of levels) {
      const rows = list.filter((r) => (r.expansionLevel || 0) === level);
      const evidence = rows.find((r) => r.evidenceNature)?.evidenceNature || '';
      out.push('');
      out.push(`## L${level}${evidence ? ' · ' + evidence : ''}`);
      const caution = rows.find((r) => r.caution)?.caution;
      if (caution) {
        out.push('');
        out.push(`> 外推提示：${caution}`);
      }
      table(rows, offset);
      offset += rows.length;
    }
  } else {
    table(list, 0);
  }

  if (withAbstract && list.some((r) => r.abstract)) {
    out.push('');
    out.push('---');
    out.push('');
    out.push('## 题录详情');
    list.forEach((r, i) => {
      out.push('');
      out.push(`### ${i + 1}. ${r.title || '(无题名)'}`);
      out.push('');
      const meta = [
        r.authors.length ? `**作者**：${r.authors.join('; ')}` : '',
        r.journal ? `**期刊**：${r.journal}${r.year ? `，${r.year}` : ''}${r.volume ? `，${r.volume}` : ''}${r.issue ? `(${r.issue})` : ''}${r.pages ? `：${r.pages}` : ''}` : '',
        r.doi ? `**DOI**：${r.doi}` : '',
        r.source ? `**来源库**：${r.source}` : '',
        `**扩展层级**：L${r.expansionLevel}${r.evidenceNature ? ' · ' + r.evidenceNature : ''}`,
        r.query ? `**实际检索式**：${r.query}` : '',
        (r.oaStatus || r.isOA) ? `**开放获取**：${r.oaStatus || 'OA'}` : '',
        r.pdfUrl ? `**全文 PDF**：${r.pdfUrl}` : (r.oaUrl ? `**全文链接**：${r.oaUrl}` : ''),
        r.fund ? `**基金**：${r.fund}` : '',
        r.keywords.length ? `**关键词**：${r.keywords.join('；')}` : '',
        r.url ? `**来源**：${r.url}` : ''
      ].filter(Boolean);
      out.push(meta.join('  \n'));
      if (withAbstract && r.abstract) {
        out.push('');
        out.push('**摘要**：' + r.abstract.replace(/\n/g, ' '));
      }
      if (detail && r.abstractEn) {
        out.push('');
        out.push('**Abstract**：' + r.abstractEn.replace(/\n/g, ' '));
      }
      if (detail && r.caution) {
        out.push('');
        out.push('**外推风险**：' + r.caution.replace(/\n/g, ' '));
      }
    });
  }
  return out.join('\n') + '\n';
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function inferFormat(out) {
  const e = path.extname(out).toLowerCase();
  if (e === '.tsv') return 'tsv';
  if (e === '.csv') return 'csv';
  if (e === '.bib') return 'bibtex';
  if (e === '.md' || e === '.markdown') return 'markdown';
  if (e === '.json') return 'json';
  return 'csv';
}

runMain(() => {
  const { options: opt } = parseArgs(process.argv.slice(2), ARG_SPEC);
  if (opt.help) { console.log(HELP); return; }
  if (!opt.input.length) {
    console.error('未指定输入。用 --input <file> 指定（可重复或逗号分隔）。\n');
    console.log(HELP);
    process.exit(2);
  }

  const fmt = opt.format || inferFormat(opt.out);
  const withAbstract = !opt.noAbstract;

  // 1. 读入
  const rawRecords = readRecords(opt.input, { label: 'export' });

  // 2. 归一化 + 丢弃空壳
  let dropped = 0;
  let list = [];
  for (const r of rawRecords) {
    const n = normalize(r);
    if (!n.title && !opt.keepEmpty) { dropped++; continue; }
    if (opt.abstractLen > 0 && n.abstract.length > opt.abstractLen) {
      n.abstract = n.abstract.slice(0, opt.abstractLen) + '…';
    }
    list.push(n);
  }
  if (dropped) console.error(`[export] 丢弃无题名记录: ${dropped}`);

  // 3. 去重
  const { list: deduped, removed } = dedup(list, opt.dedup);
  const merged = deduped.filter((r) => r.mergedFrom > 1).length;
  console.error(`[export] 去重模式 ${opt.dedup}：合并 ${removed} 条重复，${merged} 条记录得到字段补充`);
  list = deduped;

  // 4. 排序
  const cmp = {
    expansion: (a, b) => (a.expansionLevel || 0) - (b.expansionLevel || 0),
    year: (a, b) => (a.year || '9999').localeCompare(b.year || '9999'),
    'year-desc': (a, b) => (b.year || '0000').localeCompare(a.year || '0000'),
    journal: (a, b) => (a.journal || '').localeCompare(b.journal || '', 'zh'),
    title: (a, b) => (a.title || '').localeCompare(b.title || '', 'zh')
  }[opt.sort];
  if (cmp) list.sort(cmp);

  // 5. 序列化
  let content;
  switch (fmt) {
    case 'csv': content = '\uFEFF' + toDelimited(list, ',', withAbstract); break;
    case 'tsv': content = toDelimited(list, '\t', withAbstract); break;
    case 'bibtex': content = toBibtex(list, withAbstract); break;
    case 'markdown': case 'md': content = toMarkdown(list, withAbstract, opt.detail); break;
    case 'json': content = JSON.stringify(list, null, 2) + '\n'; break;
    default:
      console.error(`未知格式: ${fmt}（支持 csv / tsv / bibtex / markdown / json）`);
      process.exit(2);
  }

  // 6. 输出
  if (opt.out === '-') process.stdout.write(content);
  else {
    ensureParent(opt.out);
    fs.writeFileSync(path.resolve(opt.out), content, 'utf8');
    console.error(`[export] 写出 ${list.length} 条 → ${path.resolve(opt.out)}（格式 ${fmt}）`);
  }

  // 7. 质量提示
  const missing = {};
  for (const f of CORE_FIELDS) {
    missing[f] = list.filter((r) => {
      const v = r[f];
      return Array.isArray(v) ? v.length === 0 : !v;
    }).length;
  }
  const gaps = Object.entries(missing).filter(([, n]) => n > 0)
    .map(([f, n]) => `${f} 缺 ${n}`).join('，');
  if (gaps) console.error(`[export] 字段缺失情况：${gaps}`);
  const noKey = list.filter((r) => !r.doi && !r.title).length;
  if (noKey) console.error(`[export] 既无 DOI 也无题名的记录：${noKey}`);
});
