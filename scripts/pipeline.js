#!/usr/bin/env node
/**
 * pipeline.js — search -> open-access resolution -> export.
 * The same runtime options are passed to each stage, and a manifest records the
 * exact breakpoint so --from can resume without repeating the search.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs, runMain } = require('./lib/args');

const HERE = __dirname;
const ARG_SPEC = {
  '--query': { key: 'query', type: 'value', multiple: true, default: [] },
  '-q': { key: 'query', type: 'value', multiple: true },
  '--queries': { key: 'queries', type: 'value', multiple: true, default: [] },
  '--source': { key: 'source', default: 'openalex,crossref,europepmc' },
  '-s': { key: 'source' },
  '--limit': { key: 'limit', type: 'number', integer: true, min: 1, max: 1000, default: 20 },
  '--year-from': { key: 'yearFrom', type: 'number', integer: true, min: 1800, max: 2200, default: 0 },
  '--year-to': { key: 'yearTo', type: 'number', integer: true, min: 1800, max: 2200, default: 0 },
  '--oa-only': { key: 'oaOnly', type: 'boolean', default: false },
  '--scope': { key: 'scope', choices: ['auto', 'all', 'title-abs', 'title'], default: 'auto' },
  '--synonyms': { key: 'synonyms' },
  '--expand': { key: 'expand' },
  '--keep-noise': { key: 'keepNoise', type: 'boolean', default: false },
  '--email': { key: 'email', default: '' },
  '--core-key': { key: 'coreKey', default: process.env.CORE_API_KEY || '' },
  '--delay': { key: 'delay', type: 'number', integer: true, min: 0, default: 400 },
  '--timeout': { key: 'timeout', type: 'number', integer: true, min: 1000, default: 25000 },
  '--retries': { key: 'retries', type: 'number', integer: true, min: 0, max: 5, default: 2 },
  '--concurrency': { key: 'concurrency', type: 'number', integer: true, min: 1, max: 20, default: 5 },
  '--no-unpaywall': { key: 'unpaywall', type: 'boolean' },
  '--no-europepmc': { key: 'europepmc', type: 'boolean' },
  '--no-arxiv': { key: 'arxiv', type: 'boolean' },
  '--skip-oa': { key: 'skipOA', type: 'boolean', default: false },
  '--out-dir': { key: 'outDir', default: '.' },
  '--name': { key: 'name', default: 'literature' },
  '--format': { key: 'formats', type: 'csv', multiple: true, default: [] },
  '--from': { key: 'from', choices: ['search', 'oa', 'export'], default: 'search' },
  '--help': { key: 'help', type: 'boolean', default: false },
  '-h': { key: 'help', type: 'boolean' }
};

const HELP = `pipeline.js — 一条命令完成检索 → OA 解析 → 去重导出

  node pipeline.js -q "feeding frequency grass carp" \\
    --source openalex,europepmc --email you@example.com --out-dir output

常用参数：
  -q, --query <text>       检索词，可重复；也可用 --queries <file>
  -s, --source <list>      开放 API 源，默认 openalex,crossref,europepmc
      --limit <n>          每源每检索式条数
      --year-from / --year-to
      --synonyms <file>    同义词展开
      --expand <file>      分层检索
      --scope <mode>       auto | all | title-abs | title
      --email <addr>       OpenAlex/Crossref/Unpaywall polite pool
      --concurrency <n>    OA 逐条补查并发，默认 5
      --skip-oa            跳过全文解析，直接把检索结果交给导出
      --format <list>      csv,bibtex,markdown（默认三种）
      --out-dir <dir>      输出目录，默认当前目录
      --name <stem>        输出文件名主干，默认 literature
      --from <stage>       从 search | oa | export 阶段续跑

产物：
  <name>-hits.jsonl
  <name>-with-oa.jsonl
  <name>.csv / .bib / .md
  <name>-pipeline.json
`;

function safeName(value) {
  const name = String(value || '').trim().replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_');
  if (!name || name === '.' || name === '..') throw new Error('--name 非法');
  return name;
}

function add(command, flag, value) {
  if (value !== '' && value !== null && value !== undefined && value !== 0) command.push(flag, String(value));
}

function runStage(stage, args, state) {
  console.error(`\n[pipeline] 阶段 ${stage}: ${path.basename(args[0])}`);
  state.currentStage = stage;
  state.stages[stage] = { status: 'running', startedAt: new Date().toISOString() };
  saveState(state);
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: process.cwd() });
  if (result.error || result.status !== 0) {
    state.stages[stage] = {
      status: 'failed',
      exitCode: result.status,
      error: result.error ? result.error.message : `exit ${result.status}`,
      failedAt: new Date().toISOString()
    };
    saveState(state);
    throw new Error(`断点：${stage} 阶段失败。修复后从 --from ${stage} 重试；搜索阶段失败需重新检索，OA/导出阶段不会重复检索。`);
  }
  state.stages[stage] = { status: 'complete', finishedAt: new Date().toISOString() };
  state.currentStage = '';
  saveState(state);
}

function saveState(state) {
  fs.mkdirSync(path.dirname(state.paths.manifest), { recursive: true });
  fs.writeFileSync(state.paths.manifest, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function loadState(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { throw new Error(`流水线清单损坏: ${file}: ${err.message}`); }
}

function exportExtension(format) {
  if (format === 'bibtex') return '.bib';
  if (format === 'markdown') return '.md';
  return '.' + format;
}

runMain(() => {
  const { options: opt } = parseArgs(process.argv.slice(2), ARG_SPEC, {
    unpaywall: true,
    europepmc: true,
    arxiv: true
  });
  if (opt.help) {
    console.log(HELP);
    return;
  }

  const outDir = path.resolve(opt.outDir);
  const stem = safeName(opt.name);
  const hits = path.join(outDir, `${stem}-hits.jsonl`);
  const withOA = path.join(outDir, `${stem}-with-oa.jsonl`);
  const manifest = path.join(outDir, `${stem}-pipeline.json`);
  const previous = loadState(manifest);
  const resumed = opt.from !== 'search';
  const state = previous || {
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    currentStage: '',
    stages: {},
    paths: { hits, withOA, manifest },
    options: {}
  };
  state.paths = { hits, withOA, manifest };
  state.options = {
    source: opt.source,
    limit: opt.limit,
    emailProvided: Boolean(opt.email),
    skipOA: opt.skipOA,
    syncedAt: new Date().toISOString()
  };
  saveState(state);

  fs.mkdirSync(outDir, { recursive: true });
  if (!resumed && !opt.query.length && !opt.queries.length && !opt.expand) {
    throw new Error('首次运行需要 -q/--queries，或使用 --expand 提供分层检索式');
  }
  if (resumed) {
    const needed = opt.from === 'oa' ? hits : withOA;
    if (!fs.existsSync(needed)) throw new Error(`无法从 ${opt.from} 续跑，缺少前置文件: ${needed}`);
  }

  if (opt.from === 'search') {
    const args = [path.join(HERE, 'api-search.js')];
    for (const query of opt.query) args.push('-q', query);
    for (const file of opt.queries) args.push('--queries', file);
    args.push('--source', opt.source, '--limit', String(opt.limit));
    add(args, '--year-from', opt.yearFrom);
    add(args, '--year-to', opt.yearTo);
    if (opt.oaOnly) args.push('--oa-only');
    if (opt.keepNoise) args.push('--keep-noise');
    args.push('--scope', opt.scope, '--delay', String(opt.delay), '--timeout', String(opt.timeout));
    args.push('--retries', String(opt.retries), '--out', hits, '--no-append');
    if (opt.email) args.push('--email', opt.email);
    if (opt.coreKey) args.push('--core-key', opt.coreKey);
    if (opt.synonyms) args.push('--synonyms', opt.synonyms);
    if (opt.expand) args.push('--expand', opt.expand);
    runStage('search', args, state);
  }

  if (opt.from === 'search' || opt.from === 'oa') {
    if (opt.skipOA) {
      if (path.resolve(hits) !== path.resolve(withOA)) fs.copyFileSync(hits, withOA);
      state.stages.oa = { status: 'skipped', finishedAt: new Date().toISOString() };
      saveState(state);
    } else {
      const args = [
        path.join(HERE, 'oa-resolve.js'), '-i', hits, '-o', withOA,
        '--delay', String(opt.delay), '--timeout', String(opt.timeout),
        '--retries', String(opt.retries), '--concurrency', String(opt.concurrency), '--report'
      ];
      if (opt.email) args.push('--email', opt.email);
      if (!opt.unpaywall) args.push('--no-unpaywall');
      if (!opt.europepmc) args.push('--no-europepmc');
      if (!opt.arxiv) args.push('--no-arxiv');
      runStage('oa', args, state);
    }
  }

  const formats = Array.from(new Set(opt.formats.length ? opt.formats : ['csv', 'bibtex', 'markdown']));
  const outputs = [];
  for (const format of formats) {
    const dest = path.join(outDir, stem + exportExtension(format));
    runStage('export', [
      path.join(HERE, 'cnki-export.js'), '-i', withOA, '-o', dest,
      '--format', format, '--sort', 'expansion'
    ], state);
    outputs.push(dest);
  }
  state.outputs = outputs;
  state.completedAt = new Date().toISOString();
  saveState(state);
  console.error('\n[pipeline] 完成');
  for (const file of outputs) console.error('  ' + file);
});
