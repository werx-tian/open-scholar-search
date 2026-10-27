#!/usr/bin/env node
/**
 * selftest.js — offline regression checks and optional live API probing.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs, runMain } = require('./lib/args');
const { getText } = require('./lib/http');

const HERE = __dirname;
const ARG_SPEC = {
  '--probe': { key: 'probe', type: 'boolean', default: false },
  '--json': { key: 'json', type: 'boolean', default: false },
  '--email': { key: 'email', default: '' },
  '--core-key': { key: 'coreKey', default: process.env.CORE_API_KEY || '' },
  '--timeout': { key: 'timeout', type: 'number', integer: true, min: 1000, default: 15000 },
  '--help': { key: 'help', type: 'boolean', default: false },
  '-h': { key: 'help', type: 'boolean' }
};

const HELP = `selftest.js — 离线回归与开放 API 可用性探测

  node selftest.js          离线验证去重、层级保留与五种导出格式
  node selftest.js --probe  逐源发送轻量请求并输出可用性矩阵
  node selftest.js --probe --json
`;

function run(script, args, cwd) {
  const result = spawnSync(process.execPath, [path.join(HERE, script), ...args], {
    cwd,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error(`${script} 失败 (${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function offlineTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-scholar-selftest-'));
  const input = path.join(dir, 'sample.jsonl');
  const records = [
    {
      title: 'Effects：AI on Fish', authors: ['Zhang San'], journal: 'Aquaculture',
      year: '2024', doi: '10.1000/TEST', expansionLevel: 0,
      evidenceNature: 'A 直接证据', query: 'fish AND AI', source: 'OpenAlex'
    },
    {
      title: 'EFFECTS: AI ON FISH', authors: ['Zhang San', 'Li Si'], journal: 'Aquaculture',
      year: '2024', doi: 'https://doi.org/10.1000/test', abstract: 'Merged abstract',
      fund: 'Example Fund', expansionLevel: 2, evidenceNature: 'C 上位类群背景',
      query: 'Pisces AND AI', source: 'Crossref'
    },
    {
      title: 'effects: ai on fish', authors: ['Zhang San'], year: '2024',
      expansionLevel: 1, evidenceNature: 'B 近缘证据', query: 'Pisces AND AI'
    },
    {
      title: 'A Distinct Paper', authors: ['Wang Wu'], year: '2023',
      doi: '10.1000/OTHER', expansionLevel: 2, evidenceNature: 'C 上位类群背景'
    },
    {
      title: 'A Genus-Level Paper', authors: ['Zhao Qi'], year: '2021',
      expansionLevel: 1, evidenceNature: 'B 近缘证据'
    },
    {
      title: 'Another Distinct Paper', authors: ['Chen Liu'], year: '2022',
      expansionLevel: 0, evidenceNature: 'A 直接证据'
    }
  ];
  fs.writeFileSync(input, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  const formats = {
    csv: 'out.csv',
    tsv: 'out.tsv',
    bibtex: 'out.bib',
    markdown: 'out.md',
    json: 'out.json'
  };
  for (const [format, name] of Object.entries(formats)) {
    run('cnki-export.js', ['-i', input, '-o', path.join(dir, name), '--format', format, '--sort', 'expansion'], dir);
  }

  const csv = fs.readFileSync(path.join(dir, formats.csv), 'utf8');
  assert(csv.charCodeAt(0) === 0xFEFF, 'CSV 缺少 UTF-8 BOM');
  assert(csv.includes('扩展层级') && csv.includes('证据性质'), 'CSV 缺少扩展层级列');
  assert(fs.readFileSync(path.join(dir, formats.tsv), 'utf8').includes('\t'), 'TSV 格式无效');
  assert(fs.readFileSync(path.join(dir, formats.bibtex), 'utf8').trim().startsWith('@article'), 'BibTeX 格式无效');
  const markdown = fs.readFileSync(path.join(dir, formats.markdown), 'utf8');
  assert(markdown.includes('## L0') && markdown.includes('## L1') && markdown.includes('## L2'), 'Markdown 未按扩展层分组');

  const exported = JSON.parse(fs.readFileSync(path.join(dir, formats.json), 'utf8'));
  assert(exported.length === 4, `预期去重为 4 条，实际 ${exported.length}`);
  const merged = exported.find((record) => /test/i.test(record.doi));
  assert(merged && merged.mergedFrom >= 3, 'DOI/题名跨键合并失败');
  assert(JSON.stringify(merged.expansionLevels) === '[0,1,2]', 'expansionLevels 合并失败');
  assert(merged.abstract === 'Merged abstract' && merged.fund === 'Example Fund', '互补字段未合并');

  const unknown = spawnSync(process.execPath, [path.join(HERE, 'api-search.js'), '--definitely-unknown'], {
    cwd: dir,
    encoding: 'utf8'
  });
  assert(unknown.status === 2, '未知参数未返回 exit 2');

  console.log('PASS offline: 6 input records -> 4 deduplicated records');
  console.log('PASS formats: csv, tsv, bibtex, markdown, json');
  console.log('PASS invariants: NFKC/title dedup, complementary fields, expansionLevels, unknown-arg exit code');
  console.log('TEMP ' + dir);
}

const probes = [
  {
    source: 'OpenAlex',
    url: 'https://api.openalex.org/works?search=fish&per-page=1&select=id,display_name',
    valid: (r) => {
      const j = JSON.parse(r.body);
      return Array.isArray(j.results) && j.meta ? j.results.length : false;
    }
  },
  {
    source: 'Crossref',
    url: 'https://api.crossref.org/works?query.bibliographic=fish&rows=1',
    valid: (r) => {
      const j = JSON.parse(r.body);
      return j.message && Array.isArray(j.message.items) ? j.message.items.length : false;
    }
  },
  {
    source: 'Europe PMC',
    url: 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=fish&format=json&pageSize=1',
    valid: (r) => {
      const j = JSON.parse(r.body);
      return j.resultList && Array.isArray(j.resultList.result) ? j.resultList.result.length : false;
    }
  },
  {
    source: 'PubMed',
    url: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=fish&retmode=json&retmax=1',
    valid: (r) => {
      const j = JSON.parse(r.body);
      return j.esearchresult && Array.isArray(j.esearchresult.idlist) ? j.esearchresult.idlist.length : false;
    }
  },
  {
    source: 'DOAJ',
    url: 'https://doaj.org/api/search/articles/fish?pageSize=1',
    valid: (r) => {
      const j = JSON.parse(r.body);
      return Array.isArray(j.results) ? j.results.length : false;
    }
  },
  {
    source: 'arXiv',
    url: 'https://export.arxiv.org/api/query?search_query=all:fish&max_results=1',
    valid: (r) => /<feed[\s>]/i.test(r.body)
      ? (String(r.body).match(/<entry>/gi) || []).length
      : false
  },
  {
    source: 'CORE',
    url: 'https://api.core.ac.uk/v3/search/works?q=title:(fish)&limit=1',
    valid: (r) => {
      const j = JSON.parse(r.body);
      return Array.isArray(j.results) ? j.results.length : false;
    }
  }
];

async function probe(opt) {
  const rows = await Promise.all(probes.map(async (item) => {
    const started = Date.now();
    let result;
    try {
      result = await getText(item.url, opt, item.source);
    } catch (err) {
      result = { ok: false, status: 'ERR', error: err.message };
    }
    let state = 'available';
    let detail = '';
    let zeroResults = false;
    if (!result.ok) {
      state = result.status === 401 || result.status === 403 ? 'blocked/auth'
        : result.status === 429 ? 'rate-limited' : 'unavailable';
      detail = result.error || `HTTP ${result.status}`;
    } else {
      try {
        const count = item.valid(result);
        if (count === false || count === null || count === undefined) {
          state = 'unexpected-content';
          detail = '响应结构不符合该 API';
        } else {
          zeroResults = count === 0;
          detail = zeroResults ? 'API 可用；本次探测返回 0 条' : `${count} result(s)`;
        }
      } catch (err) {
        state = 'unexpected-content';
        detail = err.message;
      }
    }
    return {
      source: item.source,
      state,
      http: result.status,
      ms: Date.now() - started,
      zeroResults,
      detail
    };
  }));

  if (opt.json) {
    console.log(JSON.stringify({ testedAt: new Date().toISOString(), sources: rows }, null, 2));
    return;
  }
  console.log('source       state                http     ms   detail');
  for (const row of rows) {
    console.log(
      String(row.source).padEnd(12) + ' ' +
      String(row.state).padEnd(20) + ' ' +
      String(row.http).padEnd(7) + ' ' +
      String(row.ms).padStart(5) + '   ' +
      row.detail
    );
  }
}

runMain(async () => {
  const { options: opt } = parseArgs(process.argv.slice(2), ARG_SPEC);
  if (opt.help) {
    console.log(HELP);
    return;
  }
  if (opt.probe) {
    await probe(opt);
    return;
  }
  offlineTest();
});
