#!/usr/bin/env node
/**
 * expand-query.js — generate a typed, layered search configuration.
 *
 * Free sources:
 *   - NCBI Taxonomy: genus and family for a scientific name
 *   - NCBI MeSH: descriptor/tree context
 *   - OpenAlex: concepts observed in the seed result set (optional L3 candidates)
 *
 * The script expands only the object axis. Pass the same --topic to preserve the
 * treatment and outcome axes across all layers.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, runMain } = require('./lib/args');
const { ensureParent } = require('./lib/jsonl');
const { getText, getJSON } = require('./lib/http');

const ARG_SPEC = {
  '--seed': { key: 'seed' },
  '-q': { key: 'seed' },
  '--topic': { key: 'topic', default: '' },
  '--synonyms': { key: 'synonyms', default: path.join(__dirname, '..', 'references', 'synonyms.json') },
  '--out': { key: 'out', default: '-' },
  '-o': { key: 'out' },
  '--email': { key: 'email', default: '' },
  '--timeout': { key: 'timeout', type: 'number', integer: true, min: 1000, default: 20000 },
  '--retries': { key: 'retries', type: 'number', integer: true, min: 0, max: 5, default: 2 },
  '--include-l3': { key: 'includeL3', type: 'boolean', default: false },
  '--min-citations-l2': { key: 'minCitationsL2', type: 'number', integer: true, min: 0, default: 10 },
  '--min-citations-l3': { key: 'minCitationsL3', type: 'number', integer: true, min: 0, default: 25 },
  '--help': { key: 'help', type: 'boolean', default: false },
  '-h': { key: 'help', type: 'boolean' }
};

const HELP = `expand-query.js — 生成只扩展对象词的分层检索配置

  node expand-query.js "Aeromonas hydrophila" [options]

      --seed <term>               种子物种/对象词
      --topic <query>             所有层共用的处理词与指标词
      --synonyms <file>           同义词 JSON，默认 references/synonyms.json
      --include-l3                显式生成机制/背景 L3；默认只到科/类群 L2
      --min-citations-l2 <n>      L2 最低被引阈值，默认 10
      --min-citations-l3 <n>      L3 最低被引阈值，默认 25
  -o, --out <file>                输出 JSON，"-" 为 stdout（默认）
      --email <addr>              NCBI/OpenAlex polite pool 邮箱

生成结果可直接交给：
  node api-search.js --expand expand.json --source openalex,europepmc --out hits.jsonl
`;

function parseCli(argv) {
  const { options, positionals } = parseArgs(argv, ARG_SPEC);
  if (!options.help && !options.seed && positionals.length) options.seed = positionals[0];
  if (!options.help && !options.seed) throw new Error('需要种子词，例如 "Aeromonas hydrophila"');
  return options;
}

function readSynonyms(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && raw.entries && typeof raw.entries === 'object' ? raw.entries : raw;
  } catch (err) {
    return {};
  }
}

function resolveLatinSeed(seed, dictionary) {
  if (!/[\u4e00-\u9fa5]/.test(seed)) return seed;
  for (const [canonical, info] of Object.entries(dictionary || {})) {
    const terms = [canonical, ...(info.synonyms || [])];
    if (terms.includes(seed)) return info.latin || info.english || seed;
  }
  return seed;
}

function termAlternatives(seed, dictionary) {
  const terms = [seed];
  for (const [canonical, info] of Object.entries(dictionary || {})) {
    const candidates = [canonical, ...(info.synonyms || []), info.latin, info.english].filter(Boolean);
    if (candidates.includes(seed)) {
      terms.push(...candidates);
      break;
    }
  }
  return Array.from(new Set(terms.map((s) => String(s).trim()).filter(Boolean)));
}

function xmlTag(block, tag) {
  const match = String(block || '').match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? match[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim() : '';
}

async function taxonomy(seed, opt, warnings) {
  const p = new URLSearchParams({
    db: 'taxonomy',
    term: `${seed}[Scientific Name]`,
    retmode: 'json',
    retmax: '3'
  });
  if (opt.email) p.set('email', opt.email);
  const search = await getJSON(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${p}`, opt, 'NCBI Taxonomy search');
  if (!search.ok) {
    warnings.push({ source: 'NCBI Taxonomy', stage: 'search', error: search.error });
    return null;
  }
  const ids = search.json.esearchresult && search.json.esearchresult.idlist || [];
  if (!ids.length) {
    warnings.push({ source: 'NCBI Taxonomy', stage: 'search', error: '未找到分类单元' });
    return null;
  }

  const fetchParams = new URLSearchParams({ db: 'taxonomy', id: ids[0], retmode: 'xml' });
  if (opt.email) fetchParams.set('email', opt.email);
  const detail = await getText(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?${fetchParams}`, opt, 'NCBI Taxonomy fetch');
  if (!detail.ok) {
    warnings.push({ source: 'NCBI Taxonomy', stage: 'fetch', error: detail.error });
    return null;
  }

  const lineage = [];
  const lineageBlock = (detail.body.match(/<LineageEx>([\s\S]*?)<\/LineageEx>/i) || ['', ''])[1];
  const taxonRe = /<Taxon>([\s\S]*?)<\/Taxon>/gi;
  let match;
  while ((match = taxonRe.exec(lineageBlock)) !== null) {
    lineage.push({
      taxId: xmlTag(match[1], 'TaxId'),
      name: xmlTag(match[1], 'ScientificName'),
      rank: xmlTag(match[1], 'Rank').toLowerCase()
    });
  }

  const current = {
    taxId: xmlTag(detail.body, 'TaxId') || ids[0],
    name: xmlTag(detail.body, 'ScientificName') || seed,
    rank: xmlTag(detail.body, 'Rank').toLowerCase()
  };
  const all = lineage.filter((item) => item.name).concat(current);
  const byRank = (rank) => [...all].reverse().find((item) => item.rank === rank)?.name || '';
  return {
    ...current,
    lineage: all,
    genus: byRank('genus'),
    family: byRank('family')
  };
}

async function meshForName(name, opt, warnings) {
  const params = new URLSearchParams({
    db: 'mesh',
    term: `"${name}"[MeSH Terms]`,
    retmode: 'json',
    retmax: '3'
  });
  if (opt.email) params.set('email', opt.email);
  const search = await getJSON(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${params}`, opt, 'NCBI MeSH search');
  if (!search.ok) {
    warnings.push({ source: 'NCBI MeSH', stage: 'search', error: search.error });
    return null;
  }
  let ids = search.json.esearchresult && search.json.esearchresult.idlist || [];
  if (!ids.length) {
    const fallbackParams = new URLSearchParams({ db: 'mesh', term: name, retmode: 'json', retmax: '3' });
    if (opt.email) fallbackParams.set('email', opt.email);
    const fallback = await getJSON(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${fallbackParams}`, opt, 'NCBI MeSH fallback');
    if (fallback.ok) ids = fallback.json.esearchresult && fallback.json.esearchresult.idlist || [];
  }
  if (!ids.length) return null;

  async function summary(id) {
    const p = new URLSearchParams({ db: 'mesh', id, retmode: 'json' });
    if (opt.email) p.set('email', opt.email);
    const result = await getJSON(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${p}`, opt, 'NCBI MeSH summary');
    return result.ok ? result.json.result && result.json.result[id] : null;
  }

  const current = await summary(ids[0]);
  const detail = current ? { ok: true } : { ok: false, error: 'MeSH summary 无记录' };
  if (!detail.ok) {
    warnings.push({ source: 'NCBI MeSH', stage: 'fetch', error: detail.error });
    return null;
  }

  const ancestry = [];
  let cursor = current;
  const seen = new Set([ids[0]]);
  for (let depth = 0; depth < 2; depth++) {
    const link = Array.isArray(cursor.ds_idxlinks) ? cursor.ds_idxlinks[0] : null;
    const parentId = link && String(link.parent || '');
    if (!parentId || seen.has(parentId)) break;
    seen.add(parentId);
    const parent = await summary(parentId);
    if (!parent) break;
    ancestry.push({
      meshId: parentId,
      name: (parent.ds_meshterms || [])[0] || '',
      treeNumber: (parent.ds_idxlinks && parent.ds_idxlinks[0] && parent.ds_idxlinks[0].treenum) || ''
    });
    cursor = parent;
  }

  return {
    meshId: ids[0],
    descriptor: (current.ds_meshterms || [])[0] || '',
    treeNumbers: (current.ds_idxlinks || []).map((link) => link.treenum).filter(Boolean),
    ancestry
  };
}

async function openalexConcepts(seed, opt, warnings) {
  const p = new URLSearchParams({
    search: seed,
    'per-page': '20',
    select: 'id,display_name,concepts,keywords'
  });
  if (opt.email) p.set('mailto', opt.email);
  const result = await getJSON(`https://api.openalex.org/works?${p}`, opt, 'OpenAlex concepts');
  if (!result.ok) {
    warnings.push({ source: 'OpenAlex', stage: 'concepts', error: result.error });
    return [];
  }

  const counts = new Map();
  for (const work of result.json.results || []) {
    for (const concept of work.concepts || []) {
      const name = String(concept.display_name || '').trim();
      if (name) counts.set(name, (counts.get(name) || 0) + 1);
    }
    for (const keyword of work.keywords || []) {
      const name = String(keyword.display_name || keyword || '').trim();
      if (name) counts.set(name, (counts.get(name) || 0) + 0.5);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name, score]) => ({ name, score, source: 'openalex-concept' }));
}

function quotedOr(terms) {
  const clean = Array.from(new Set(terms.map((s) => String(s || '').trim()).filter(Boolean)));
  return clean.length <= 1 ? (clean[0] || '') : '(' + clean.map((s) => /\s/.test(s) ? `"${s}"` : s).join(' OR ') + ')';
}

function appendTopic(query, topic) {
  return topic ? `(${query}) AND (${topic})` : query;
}

function buildLayers(seed, alternatives, taxonomyInfo, meshInfo, concepts, opt) {
  const genus = taxonomyInfo?.genus || (seed.includes(' ') ? seed.split(/\s+/)[0] : '');
  const family = taxonomyInfo?.family || '';
  const meshParent = [...(meshInfo?.ancestry || [])]
    .reverse()
    .find((item) => item.name && item.name !== seed && item.name !== genus)?.name || '';
  const conceptTerms = concepts
    .map((item) => item.name)
    .filter((name) => name && ![seed, genus, family].includes(name))
    .slice(0, 6);

  const layers = [{
    level: 0,
    label: 'L0 本种/本概念直接证据',
    evidenceNature: 'A 直接证据',
    query: appendTopic(quotedOr(alternatives), opt.topic),
    limit: 50,
    scope: 'title-abs',
    minCitations: 0,
    objectTerms: alternatives,
    source: 'seed'
  }];

  if (genus && !alternatives.includes(genus)) {
    layers.push({
      level: 1,
      label: 'L1 同属近缘证据',
      evidenceNature: 'B 近缘证据',
      query: appendTopic(genus, opt.topic),
      limit: 30,
      scope: 'title-abs',
      minCitations: 0,
      objectTerms: [genus],
      source: 'ncbi-taxonomy',
      caution: '同属其他种的宿主特异性、剂量效应和流行病学结论不能直接外推到目标物种。'
    });
  }

  const familyOrParent = family || meshParent;
  if (familyOrParent && ![seed, genus].includes(familyOrParent)) {
    layers.push({
      level: 2,
      label: 'L2 科/类群上位证据',
      evidenceNature: 'C 上位类群背景',
      query: appendTopic(familyOrParent, opt.topic),
      limit: 20,
      scope: 'title',
      minCitations: opt.minCitationsL2,
      objectTerms: [familyOrParent],
      source: family ? 'ncbi-taxonomy' : 'ncbi-mesh',
      caution: '上位类群层只用于机制、术语和背景，不用于估计目标物种的效应大小。'
    });
  }

  if (opt.includeL3 && conceptTerms.length) {
    layers.push({
      level: 3,
      label: 'L3 机制/背景概念层',
      evidenceNature: 'D 机制或背景证据',
      query: appendTopic(quotedOr(conceptTerms), opt.topic),
      limit: 10,
      scope: 'title',
      minCitations: opt.minCitationsL3,
      objectTerms: conceptTerms,
      source: 'openalex-concept',
      caution: '该层来自数据驱动的高频概念，可能混入其他宿主、疾病阶段或学科语境；不得将上位层结论反推为目标物种的直接证据。'
    });
  }
  return layers;
}

runMain(async () => {
  const opt = parseCli(process.argv.slice(2));
  if (opt.help) {
    console.log(HELP);
    return;
  }

  const dictionary = readSynonyms(opt.synonyms);
  const latinSeed = resolveLatinSeed(opt.seed, dictionary);
  const alternatives = termAlternatives(opt.seed, dictionary);
  if (latinSeed && !alternatives.includes(latinSeed)) alternatives.push(latinSeed);
  const warnings = [];

  console.error(`[expand] 种子: ${opt.seed}${latinSeed !== opt.seed ? ` → ${latinSeed}` : ''}`);
  const [taxonomyInfo, meshInfo, concepts] = await Promise.all([
    taxonomy(latinSeed, opt, warnings),
    meshForName(latinSeed, opt, warnings),
    openalexConcepts(latinSeed, opt, warnings)
  ]);
  const layers = buildLayers(latinSeed, alternatives, taxonomyInfo, meshInfo, concepts, opt);

  const output = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    seed: opt.seed,
    latinSeed,
    dimensions: {
      object: '按分类学/类群逐层扩展',
      treatmentAndOutcome: opt.topic || '(未提供；所有层保持为空)',
      rule: '只改变对象词；处理词和指标词在各层保持一致'
    },
    taxonomy: taxonomyInfo,
    mesh: meshInfo,
    openalexConcepts: concepts,
    layerDefaults: { 0: 50, 1: 30, 2: 20, 3: 10 },
    rankedSources: ['openalex', 'europepmc'],
    includeL3: opt.includeL3,
    warnings,
    layers
  };

  const text = JSON.stringify(output, null, 2) + '\n';
  if (opt.out === '-') process.stdout.write(text);
  else {
    ensureParent(opt.out);
    fs.writeFileSync(path.resolve(opt.out), text, 'utf8');
    console.error(`[expand] 写出 ${layers.length} 层 → ${path.resolve(opt.out)}`);
  }
});
