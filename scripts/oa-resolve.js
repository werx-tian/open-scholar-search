#!/usr/bin/env node
/**
 * oa-resolve.js — 批量解析题录的开放获取（Open Access）全文链接
 *
 * 输入任意来源的题录 JSONL（cnki-grab.js / api-search.js / 手工整理均可），
 * 逐条尝试从多个开放渠道找到免费全文，并把结果回写到记录中。
 *
 * 解析顺序（先批量后逐条，兼顾效率与覆盖面）：
 *   阶段一   OpenAlex 批量 DOI 查询（每批 50 个 DOI 一次请求，最快）
 *   阶段二   对阶段一未命中的记录逐条补查：
 *            Unpaywall（需 --email）→ Europe PMC → arXiv 题名检索
 *
 * 用法：
 *   node oa-resolve.js --input records.jsonl --out with-oa.jsonl --email you@example.com
 *
 * 参数：
 *   --input, -i <file>   输入题录，支持 .jsonl/.ndjson/.json，可重复或用逗号分隔
 *   --out, -o <file>     输出 JSONL，默认 with-oa.jsonl，"-" 输出到 stdout
 *   --email <addr>       邮箱。OpenAlex polite pool + 解锁 Unpaywall（Unpaywall 强制要求真实邮箱）
 *   --only-oa            只输出成功解析到全文链接的记录
 *   --report             结束时打印开放获取情况统计
 *   --skip-resolved      跳过已有 oaUrl 的记录（重复运行时避免重复查询）
 *   --no-unpaywall       不使用 Unpaywall
 *   --no-europepmc       不使用 Europe PMC
 *   --no-arxiv           不使用 arXiv
 *   --batch <n>          OpenAlex 每批 DOI 数，默认 50（上限 50）
 *   --delay <ms>         逐条阶段的请求间隔，默认 600
 *   --concurrency <n>    逐条补查并发数，默认 5
 *   --timeout <ms>       单请求超时，默认 25000
 *   --help
 *
 * 示例：
 *   # 检索后立刻找全文
 *   node api-search.js -q "feeding frequency grass carp" -s openalex,europepmc -o hits.jsonl
 *   node oa-resolve.js -i hits.jsonl -o with-oa.jsonl --email you@example.com --report
 *   node cnki-export.js -i with-oa.jsonl -o 清单.csv --format csv
 */

'use strict';

const path = require('path');
const { parseArgs, runMain } = require('./lib/args');
const { readRecords, writeJsonl } = require('./lib/jsonl');
const { sleep, getText, limiterFor, mapLimit } = require('./lib/http');

/* ------------------------------------------------------------------ *
 * 参数
 * ------------------------------------------------------------------ */

const ARG_SPEC = {
  '--input': { key: 'input', type: 'csv', multiple: true, default: [] },
  '-i': { key: 'input', type: 'csv', multiple: true },
  '--out': { key: 'out', default: 'with-oa.jsonl' },
  '-o': { key: 'out' },
  '--email': { key: 'email', default: '' },
  '--only-oa': { key: 'onlyOA', type: 'boolean', default: false },
  '--report': { key: 'report', type: 'boolean', default: false },
  '--skip-resolved': { key: 'skipResolved', type: 'boolean', default: false },
  '--no-unpaywall': { key: 'unpaywall', type: 'boolean' },
  '--no-europepmc': { key: 'europepmc', type: 'boolean' },
  '--no-arxiv': { key: 'arxiv', type: 'boolean' },
  '--batch': { key: 'batch', type: 'number', integer: true, min: 1, max: 50, default: 50 },
  '--delay': { key: 'delay', type: 'number', integer: true, min: 0, default: 600 },
  '--concurrency': { key: 'concurrency', type: 'number', integer: true, min: 1, max: 20, default: 5 },
  '--timeout': { key: 'timeout', type: 'number', integer: true, min: 1000, default: 25000 },
  '--retries': { key: 'retries', type: 'number', integer: true, min: 0, max: 5, default: 2 },
  '--help': { key: 'help', type: 'boolean', default: false },
  '-h': { key: 'help', type: 'boolean' }
};

const HELP = `oa-resolve.js — 批量解析开放获取全文链接

  node oa-resolve.js --input records.jsonl --out with-oa.jsonl --email <你的邮箱>

  -i, --input <file>   题录 JSONL/JSON，可重复或逗号分隔
  -o, --out <file>     输出 JSONL，默认 with-oa.jsonl，"-" 为 stdout
      --email <addr>   OpenAlex polite pool；同时解锁 Unpaywall（必需）
      --only-oa        只输出解析到全文的记录
      --report         打印开放获取统计
      --skip-resolved  跳过已有 oaUrl 的记录
      --no-unpaywall / --no-europepmc / --no-arxiv
      --batch <n>      OpenAlex 每批 DOI 数，默认 50
      --delay <ms>     逐条阶段间隔，默认 600
      --concurrency n  逐条补查并发数，默认 5（各源仍独立限速）

解析顺序：OpenAlex 批量 DOI → Unpaywall → Europe PMC → arXiv 题名检索
`;

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

const toHalf = (s) => String(s == null ? '' : s)
  .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
  .replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim();

const normDoi = (d) => String(d || '').toLowerCase().trim()
  .replace(/^https?:\/\/(dx\.)?doi\.org\//, '').replace(/^doi[:\s]*/i, '').replace(/[.,;]+$/, '');

/** 题名归一化：用于跨源比对 / 去重，去标点空格、全角转半角、转小写 */
const normTitle = (t) => toHalf(t).toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');

async function get(url, opt, acceptJson = true) {
  const source = /unpaywall/.test(url) ? 'Unpaywall'
    : /europepmc/.test(url) ? 'Europe PMC'
      : /arxiv/.test(url) ? 'arXiv' : 'OpenAlex';
  const limiter = limiterFor(source, {
    minInterval: source === 'arXiv' ? 3000 : source === 'Europe PMC' ? 250 : source === 'Unpaywall' ? 150 : 100
  });
  return limiter.run(async () => {
    const result = await getText(url, {
      ...opt,
      accept: acceptJson ? 'application/json,application/atom+xml,*/*' : '*/*'
    }, source);
    return {
      status: result.status,
      ok: result.ok,
      body: result.body,
      error: result.error || ''
    };
  });
}

/** 只接受看起来像可访问全文的链接；landing page 与 pdf 分开归类 */
function looksPdf(u) { return /\.pdf(\?|#|$)/i.test(u || '') || /\/pdf\/?(\?|#|$)/i.test(u || ''); }

function setOA(rec, info) {
  if (!info || !info.url) return false;
  rec.isOA = true;
  rec.oaStatus = info.status || rec.oaStatus || 'open';
  rec.oaSource = info.source || '';
  if (!rec.oaUrl) rec.oaUrl = info.url;
  if (!rec.pdfUrl && (info.pdf || looksPdf(info.url))) rec.pdfUrl = info.pdf || info.url;
  return true;
}

const pickField = (rec, keys) => {
  for (const k of keys) if (rec[k] != null && rec[k] !== '') return rec[k];
  return '';
};

function addWarning(rec, source, error, context = {}) {
  rec._warnings = Array.isArray(rec._warnings) ? rec._warnings : [];
  rec._warnings.push({
    source,
    error: String(error || 'unknown'),
    time: new Date().toISOString(),
    ...context
  });
}

/* ------------------------------------------------------------------ *
 * 阶段一：OpenAlex 批量 DOI 查询
 * ------------------------------------------------------------------ */

async function openalexBatch(records, opt) {
  const jobs = [];
  records.forEach((rec, idx) => {
    const doi = normDoi(pickField(rec, ['doi', 'DOI']));
    if (doi) jobs.push({ idx, doi });
  });
  if (!jobs.length) return { hit: 0, queries: 0 };

  const byDoi = new Map();
  const size = opt.batch || 50;
  let queries = 0;

  for (let i = 0; i < jobs.length; i += size) {
    const chunk = jobs.slice(i, i + size);
    const filter = 'doi:' + chunk.map((j) => j.doi).join('|');
    const p = new URLSearchParams({ filter, 'per-page': String(size) });
    if (opt.email) p.set('mailto', opt.email);
    const r = await get(`https://api.openalex.org/works?${p}`, opt);
    queries++;
    if (!r.ok) {
      console.error(`  [OpenAlex 批量] 第 ${queries} 批失败: ${r.status} ${r.body.slice(0, 90)}`);
      for (const job of chunk) addWarning(records[job.idx], 'OpenAlex', r.error || `${r.status} ${r.body.slice(0, 90)}`, { stage: 'oa-batch' });
      await sleep(800);
      continue;
    }
    let j;
    try { j = JSON.parse(r.body); } catch (e) {
      for (const job of chunk) addWarning(records[job.idx], 'OpenAlex', 'JSON 解析失败', { stage: 'oa-batch' });
      continue;
    }
    for (const w of (j.results || [])) {
      const d = normDoi(w.doi || '');
      if (d) byDoi.set(d, w);
    }
    await sleep(300);
  }

  let hit = 0;
  for (const job of jobs) {
    const w = byDoi.get(job.doi);
    if (!w) continue;
    const rec = records[job.idx];
    rec.openalexId = w.id || '';
    if (w.cited_by_count != null) rec.citations = w.cited_by_count;
    if (!rec.abstract && w.abstract_inverted_index) {
      const arr = [];
      for (const [word, poses] of Object.entries(w.abstract_inverted_index)) for (const p of poses) arr[p] = word;
      const abs = arr.filter(Boolean).join(' ').trim();
      if (abs) rec.abstract = abs;
    }
    const best = w.best_oa_location || {};
    const locs = Array.isArray(w.locations) ? w.locations : [];
    // 关键：locations 里混有「付费」的出版商落地页，只有 is_oa === true 的才是能免费拿到的。
    // 若不过滤，closed 状态的记录会被错误标记成有全文，误导用户。
    const oaLocs = locs.filter((l) => l && l.is_oa === true);
    const oaPdf = oaLocs.find((l) => l.pdf_url);
    const oaLand = oaLocs.find((l) => l.landing_page_url);
    const oa = w.open_access || {};
    const status = oa.oa_status || 'open';
    let ok = false;
    if (oa.is_oa === false && !oaLocs.length && !best.pdf_url && !best.landing_page_url) {
      rec.oaStatus = status === 'closed' ? 'closed' : status;
      rec.oaSource = 'OpenAlex(无免费全文)';
    } else if (best.pdf_url) {
      ok = setOA(rec, { url: best.pdf_url, pdf: best.pdf_url, status, source: 'OpenAlex' });
    } else if (oaPdf) {
      ok = setOA(rec, { url: oaPdf.pdf_url, pdf: oaPdf.pdf_url, status, source: 'OpenAlex' });
    } else if (best.landing_page_url) {
      ok = setOA(rec, { url: best.landing_page_url, status, source: 'OpenAlex' });
    } else if (oaLand) {
      ok = setOA(rec, { url: oaLand.landing_page_url, status, source: 'OpenAlex' });
    } else {
      rec.oaStatus = status === 'closed' ? 'closed' : status;
      rec.oaSource = 'OpenAlex(无免费全文)';
    }
    if (ok) hit++;
  }
  console.error(`  [OpenAlex 批量] ${queries} 次请求覆盖 ${jobs.length} 个 DOI，确认有免费全文 ${hit} 条`);
  return { hit, queries };
}

/* ------------------------------------------------------------------ *
 * 阶段二：逐条补查
 * ------------------------------------------------------------------ */

async function unpaywallOne(doi, opt) {
  const p = new URLSearchParams({ email: opt.email });
  const r = await get(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?${p}`, opt);
  if (!r.ok) return { status: r.status, body: r.body };
  let j;
  try { j = JSON.parse(r.body); } catch (e) { return { status: 'parse-error' }; }
  if (!j.is_oa && !j.best_oa_location) return { found: false, oaStatus: j.oa_status || 'closed' };
  const best = j.best_oa_location || {};
  const loc = best.url_for_pdf || best.url ? best : ((j.oa_locations || [])[0] || {});
  return {
    found: true,
    url: best.url_for_pdf || best.url || loc.url_for_pdf || loc.url || '',
    pdf: best.url_for_pdf || loc.url_for_pdf || '',
    oaStatus: j.oa_status || 'open'
  };
}

async function europepmcOne(rec, opt) {
  const doi = normDoi(pickField(rec, ['doi', 'DOI']));
  const title = toHalf(pickField(rec, ['title', '题名']));
  const q = doi ? `DOI:"${doi}"` : (title ? `TITLE:"${title.replace(/"/g, '')}"` : '');
  if (!q) return { found: false };
  const p = new URLSearchParams({ query: q, format: 'json', resultType: 'core', pageSize: '1' });
  const r = await get(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?${p}`, opt);
  if (!r.ok) return { status: r.status };
  let j;
  try { j = JSON.parse(r.body); } catch (e) { return { status: 'parse-error' }; }
  const hit = ((j.resultList && j.resultList.result) || [])[0];
  if (!hit) return { found: false };
  // 题名不一致时不要误判（无 DOI 的情况下尤其重要）
  if (!doi) {
    const a = normTitle(title), b = normTitle(hit.title || '');
    if (!a || !b || !(a === b || a.includes(b) || b.includes(a))) return { found: false, skipped: 'title-mismatch' };
  }
  const urls = ((hit.fullTextUrlList || {}).fullTextUrl || []).filter((u) => u.availability !== 'Subscription');
  const pdf = urls.find((u) => u.documentStyle === 'pdf');
  const html = urls.find((u) => u.documentStyle === 'html');
  const pmcid = hit.pmcid || '';
  if (pdf) return { found: true, url: pdf.url, pdf: pdf.url, oaStatus: 'europepmc-pdf', pmid: hit.pmid, pmcid };
  if (html) return { found: true, url: html.url, oaStatus: 'europepmc-html', pmid: hit.pmid, pmcid };
  if (pmcid) return { found: true, url: 'https://www.ncbi.nlm.nih.gov/pmc/articles/' + pmcid + '/', oaStatus: 'pmc', pmid: hit.pmid, pmcid };
  return { found: false, pmid: hit.pmid };
}

async function arxivOne(rec, opt) {
  const title = toHalf(pickField(rec, ['title', '题名']));
  if (!title) return { found: false };
  const p = new URLSearchParams({ search_query: `ti:"${title.replace(/"/g, '')}"`, max_results: '1' });
  const r = await get(`https://export.arxiv.org/api/query?${p}`, opt, false);
  if (!r.ok) return { status: r.status };
  const block = r.body.split(/<entry>/)[1];
  if (!block) return { found: false };
  const entry = block.split('</entry>')[0];
  const at = normTitle((entry.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [, ''])[1]);
  const a = normTitle(title);
  // arXiv 的题名检索很宽松，必须校验题名以排除误匹配
  if (!at || !(at === a || (a.length > 20 && (at.includes(a.slice(0, 20)) || a.includes(at.slice(0, 20)))))) {
    return { found: false, skipped: 'title-mismatch' };
  }
  const idUrl = ((entry.match(/<id>([^<]+)<\/id>/) || [, ''])[1] || '').trim();
  if (!idUrl) return { found: false };
  return { found: true, url: idUrl, pdf: idUrl.replace('/abs/', '/pdf/'), oaStatus: 'arxiv-preprint' };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

runMain(async () => {
  const { options: opt } = parseArgs(process.argv.slice(2), ARG_SPEC, {
    unpaywall: true,
    europepmc: true,
    arxiv: true
  });
  if (opt.help) { console.log(HELP); return; }
  if (!opt.input.length) {
    console.error('未指定输入。用 --input <file>。\n');
    console.log(HELP);
    process.exit(2);
  }
  if (opt.unpaywall && !opt.email) {
    console.error('[oa] 未提供 --email，Unpaywall 会被跳过（该接口强制要求真实邮箱）。');
    opt.unpaywall = false;
  }

  const records = readRecords(opt.input, { label: 'oa' });
  if (!records.length) { console.error('[oa] 没有可处理的记录'); process.exit(2); }

  const before = records.filter((r) => r.oaUrl || r.pdfUrl).length;
  console.error(`[oa] 已有全文链接 ${before} 条\n`);

  // 阶段一
  console.error('[oa] 阶段一：OpenAlex 批量 DOI 解析');
  await openalexBatch(records, opt);

  // 阶段二
  const pending = records.filter((r) => {
    if (opt.skipResolved && (r.oaUrl || r.pdfUrl)) return false;
    if (r.pdfUrl) return false;              // 已有 PDF 就不必再找
    return true;
  });
  console.error(`\n[oa] 阶段二：逐条补查 ${pending.length} 条（Unpaywall → Europe PMC → arXiv）`);

  let filled = 0, tried = 0;
  const outcomes = await mapLimit(pending, opt.concurrency, async (rec) => {
    const doi = normDoi(pickField(rec, ['doi', 'DOI']));
    const completed = ++tried;
    let got = null;

    if (opt.unpaywall && doi) {
      const u = await unpaywallOne(doi, opt);
      if (u.found && (u.url || u.pdf)) got = { url: u.pdf || u.url, pdf: u.pdf, status: u.oaStatus, source: 'Unpaywall' };
      else if (u.oaStatus) rec.oaStatus = rec.oaStatus || u.oaStatus;
      else if (u.status && u.status !== 404) addWarning(rec, 'Unpaywall', u.body || u.status, { doi });
      await sleep(opt.delay);
    }
    if (!got && opt.europepmc) {
      const e = await europepmcOne(rec, opt);
      if (e.found) got = { url: e.url, pdf: e.pdf, status: e.oaStatus, source: 'Europe PMC' };
      if (e.pmid) rec.pmid = e.pmid;
      if (e.pmcid) rec.pmcid = e.pmcid;
      if (e.status && e.status !== 404) addWarning(rec, 'Europe PMC', e.status, { doi });
      await sleep(opt.delay);
    }
    if (!got && opt.arxiv) {
      const a = await arxivOne(rec, opt);
      if (a.found) got = { url: a.url, pdf: a.pdf, status: a.oaStatus, source: 'arXiv' };
      if (a.status) addWarning(rec, 'arXiv', a.status, { doi });
      await sleep(300);
    }

    if (got) {
      setOA(rec, got);
      filled++;
    }
    if (completed % 20 === 0) console.error(`  ...已处理 ${completed}/${pending.length}，新解析到全文 ${filled} 条`);
    return !!got;
  });
  filled = outcomes.filter(Boolean).length;

  // 写出
  const out = opt.onlyOA ? records.filter((r) => r.oaUrl || r.pdfUrl) : records;
  const stamp = new Date().toISOString();
  for (const r of out) if (r.isOA || r.oaUrl) r.oaResolvedAt = stamp;
  writeJsonl(out, opt.out);
  if (opt.out !== '-') console.error(`\n[oa] 写出 ${out.length} 条 → ${path.resolve(opt.out)}`);

  const withPdf = records.filter((r) => r.pdfUrl).length;
  const withAny = records.filter((r) => r.oaUrl || r.pdfUrl).length;
  const gold = records.filter((r) => /gold|hybrid/.test(r.oaStatus || '')).length;
  console.error(`[oa] 本批新解析到全文 ${filled} 条`);
  console.error(`[oa] 合计：有免费全文 ${withAny}/${records.length}，其中直接 PDF ${withPdf}，金色/混合 OA 期刊 ${gold}`);

  if (opt.report) {
    const bySource = {};
    for (const r of records) {
      const k = r.oaSource || '(未解析)';
      bySource[k] = (bySource[k] || 0) + 1;
    }
    console.error('\n[oa] 按来源分布');
    for (const [k, v] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
      console.error(`  ${String(v).padStart(4)}  ${k}`);
    }
  }

  if (opt.out !== '-') {
    console.error(`\n  下一步：node cnki-export.js -i "${opt.out}" -o 文献清单.csv --format csv`);
  }
});
