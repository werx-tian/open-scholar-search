#!/usr/bin/env node
/**
 * cnki-grab.js — 从知网期刊协同编辑门户（*.cbpt.cnki.net）批量抽取结构化题录
 *
 * DISCLAIMER: only fetch publicly accessible pages that you are authorized to
 * view. Users are responsible for the target site's terms and robots policy.
 * This tool does not bypass access controls.
 *
 * 零依赖：只用 Node 18+ 内置的 fetch / WebSocket / child_process。
 *
 * 用法：
 *   node cnki-grab.js --urls urls.txt --out records.jsonl [options]
 *
 * 参数：
 *   --urls <file>     每行一个 URL 的文本文件（# 开头为注释），或 JSON 数组文件
 *   --url <url>       单个 URL，可重复
 *   --out <file>      输出 JSONL 路径（追加写入），默认 records.jsonl
 *   --wait <ms>       每页导航后等待渲染的时间，默认 6000
 *   --delay <ms>      页面之间的间隔，默认 1500（降低风控概率）
 *   --limit <n>       最多处理前 n 个 URL
 *   --warm <url>      抓取前先访问该地址建立 cookie，建议传目标站点首页
 *   --launch          自动探测并拉起 Edge/Chrome（headless + CDP 9222）
 *   --keep-open       与 --launch 搭配：结束时保留浏览器进程
 *   --raw             额外输出页面纯文本前 2000 字符，便于排查抽取失败
 *   --cdp <endpoint>  CDP 地址，默认 http://127.0.0.1:9222
 *   --no-append       覆盖而不是追加输出文件
 *   --help            显示帮助
 *
 * 示例：
 *   node cnki-grab.js --launch --warm https://www.cnki.net/ \
 *     --urls urls.txt --out records.jsonl --wait 6000
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { parseArgs, runMain } = require('./lib/args');
const { createJsonlWriter, ensureParent } = require('./lib/jsonl');

/* ------------------------------------------------------------------ *
 * 参数解析
 * ------------------------------------------------------------------ */

const ARG_SPEC = {
  '--urls': { key: 'urls', type: 'value', multiple: true, default: [] },
  '--url': { key: 'url', type: 'value', multiple: true, default: [] },
  '--out': { key: 'out', default: 'records.jsonl' },
  '-o': { key: 'out' },
  '--wait': { key: 'wait', type: 'number', integer: true, min: 0, default: 6000 },
  '--delay': { key: 'delay', type: 'number', integer: true, min: 0, default: 1500 },
  '--limit': { key: 'limit', type: 'number', integer: true, min: 0, default: 0 },
  '--warm': { key: 'warm', default: '' },
  '--cdp': { key: 'cdp', default: process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222' },
  '--launch': { key: 'launch', type: 'boolean', default: false },
  '--keep-open': { key: 'keepOpen', type: 'boolean', default: false },
  '--raw': { key: 'raw', type: 'boolean', default: false },
  '--no-append': { key: 'append', type: 'boolean' },
  '--help': { key: 'help', type: 'boolean', default: false },
  '-h': { key: 'help', type: 'boolean' }
};

const HELP = `cnki-grab.js — 从 cbpt 期刊门户批量抽取结构化题录

  node cnki-grab.js --urls urls.txt --out records.jsonl [options]

  --urls <file>     每行一个 URL（# 为注释）或 JSON 数组文件，可重复
  --url <url>       单个 URL，可重复
  --out <file>      JSONL 输出路径，默认 records.jsonl
  --wait <ms>       导航后等待渲染，默认 6000
  --delay <ms>      页面间隔，默认 1500
  --limit <n>       只处理前 n 个
  --warm <url>      先访问该地址建立 cookie
  --launch          自动拉起 Edge/Chrome（headless CDP 9222）
  --keep-open       保留拉起的浏览器进程
  --raw             附带页面纯文本前 2000 字符
  --cdp <endpoint>  CDP 地址，默认 http://127.0.0.1:9222
  --no-append       覆盖输出文件
`;

/* ------------------------------------------------------------------ *
 * 页内抽取器 —— 通过 Function.prototype.toString 注入到浏览器执行。
 * 先取 citation_* meta（知网门户普遍输出），失败再用中文标签正则兜底。
 * ------------------------------------------------------------------ */

function extractInPage() {
  const clean = (s) => String(s == null ? '' : s).replace(/[ \t\u3000]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const oneLine = (s) => clean(s).replace(/\s*\n\s*/g, ' ').trim();

  const metaAll = (name) => Array.from(
    document.querySelectorAll('meta[name="' + name + '"],meta[property="' + name + '"]')
  ).map((e) => (e.getAttribute('content') || '').trim()).filter(Boolean);
  const metaOne = (name) => metaAll(name)[0] || '';

  const text = (document.body ? document.body.innerText : '').replace(/\r/g, '');

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // 从首个命中的起始标签起截取，直到任一终止标签或长度上限
  function block(labels, stops, max) {
    let idx = -1, hit = '';
    for (const L of labels) {
      const k = text.indexOf(L);
      if (k >= 0 && (idx < 0 || k < idx)) { idx = k; hit = L; }
    }
    if (idx < 0) return '';
    let rest = text.slice(idx + hit.length).replace(/^[\s:：]+/, '');
    let end = rest.length;
    for (const S of (stops || [])) {
      const k = rest.search(new RegExp('\\n\\s*' + esc(S)));
      if (k >= 0 && k < end) end = k;
    }
    return rest.slice(0, Math.min(end, max || 4000)).trim();
  }

  const title = oneLine(metaOne('citation_title')) || oneLine(block(['题名', '篇名', '标题'], ['作者', '摘要', 'Abstract'], 300));
  const authors = metaAll('citation_author').map(oneLine).filter(Boolean);
  const journal = oneLine(metaOne('citation_journal_title')) || oneLine(block(['刊名', '期刊名称'], ['年', '卷', '期'], 100));

  const dateRaw = metaOne('citation_publication_date') || metaOne('citation_date') || '';
  const yearFromText = (block(['出版年', '年卷期'], ['摘要', '关键词'], 60).match(/\b(19|20)\d{2}\b/) || [])[0] || '';
  const year = (dateRaw.match(/\b(19|20)\d{2}\b/) || [])[0] || yearFromText;

  const volume = oneLine(metaOne('citation_volume'));
  const issue = oneLine(metaOne('citation_issue'));
  const firstPage = oneLine(metaOne('citation_firstpage'));
  const lastPage = oneLine(metaOne('citation_lastpage'));
  let pages = '';
  if (firstPage && lastPage) pages = firstPage + '-' + lastPage;
  else if (firstPage) pages = firstPage;
  if (!pages) pages = oneLine(block(['页码', '页数'], ['摘要', '关键词', 'DOI'], 40)).replace(/\D+$/, '');

  let doi = oneLine(metaOne('citation_doi'));
  if (!doi) {
    const m = text.match(/10\.\d{4,9}\/[^\s"“”'，。；）)】\]]+/);
    if (m) doi = m[0];
  }

  const kwRaw = metaAll('citation_keywords').join(';') || metaOne('keywords') ||
    block(['关键词', '关键字'], ['摘要', 'Abstract', '基金', 'DOI', '参考文献'], 400);
  const keywords = kwRaw.split(/[;；,，、\/]+/).map(oneLine).filter(Boolean);

  const abstract = clean(
    metaOne('citation_abstract') ||
    metaOne('description') ||
    block(['中文摘要', '摘要', '【摘要】'], ['关键词', '关键字', 'Abstract', '基金', '参考文献', 'DOI', '收稿'], 3000)
  );

  const abstractEn = clean(
    metaOne('citation_abstract_en') ||
    block(['Abstract', 'ABSTRACT'], ['Key words', 'Keywords', '关键词', '参考文献', '基金'], 3000)
  );

  const fund = oneLine(metaOne('citation_fund') || block(
    ['基金项目', '基金', '资助项目'],
    ['作者简介', '通信作者', '通讯作者', '作者', '摘要', '关键词', '关键字', 'DOI', '收稿', '参考文献', 'References', 'Abstract'],
    300
  ));

  const refs = block(['参考文献'], ['上一页', '下一页', '相关文献', '引证文献', '同被引文献', '读者推荐'], 8000);

  return {
    title,
    authors,
    journal,
    year,
    volume,
    issue,
    pages,
    doi,
    keywords,
    abstract,
    abstractEn,
    fund,
    referencesText: refs,
    referencesCount: (refs.match(/\[\d+\]/g) || []).length,
    url: location.href,
    pageTitle: document.title,
    textLength: text.length,
    textHead: text.slice(0, 2000)
  };
}

/* ------------------------------------------------------------------ *
 * 浏览器启动探测（--launch）
 * ------------------------------------------------------------------ */

function detectBrowsers() {
  const cands = [];
  if (process.env.BROWSER_PATH) cands.push(process.env.BROWSER_PATH);
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pfx86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env['LOCALAPPDATA'] || '';
    cands.push(
      path.join(pfx86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pfx86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')
    );
  } else if (process.platform === 'darwin') {
    cands.push(
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    );
  } else {
    for (const n of ['microsoft-edge', 'microsoft-edge-stable', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
      const r = spawnSync('which', [n], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) cands.push(r.stdout.trim());
    }
  }
  return cands.filter((p) => p && fs.existsSync(p));
}

async function waitForCdp(endpoint, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(endpoint + '/json/version');
      if (r.ok) return await r.json();
    } catch (e) { /* 还没起来 */ }
    await sleep(400);
  }
  return null;
}

async function launchBrowser(endpoint) {
  const port = (endpoint.match(/:(\d+)/) || [])[1] || '9222';
  const alive = await waitForCdp(endpoint, 1500);
  if (alive) { console.error(`[grab] 复用已运行的浏览器: ${alive.Browser}`); return null; }

  const list = detectBrowsers();
  if (!list.length) {
    console.error('[grab] 未探测到 Edge/Chrome，请手动启动或改用 --cdp 指定地址');
    return null;
  }
  const exe = list[0];
  const profile = path.join(os.tmpdir(), 'cnki-cdp-profile-' + Date.now());
  console.error(`[grab] 启动浏览器: ${exe}\n[grab] profile: ${profile}`);

  const args = [
    '--headless=new', '--disable-gpu', '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
    '--window-size=1600,1200', 'about:blank'
  ];
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();

  const ok = await waitForCdp(endpoint, 20000);
  if (!ok) { console.error('[grab] 浏览器启动后 CDP 仍不可达，请检查端口占用'); return null; }
  console.error(`[grab] 就绪: ${ok.Browser}`);
  return { pid: child.pid, profile, exe };
}

/* ------------------------------------------------------------------ *
 * CDP 最小客户端
 * ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newTab(endpoint, url) {
  const r = await fetch(`${endpoint}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!r.ok) throw new Error(`/json/new HTTP ${r.status}`);
  return r.json();
}

async function closeTab(endpoint, id) {
  try { await fetch(`${endpoint}/json/close/${id}`); } catch (e) { /* ignore */ }
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      send(method, params, timeoutMs = 40000) {
        return new Promise((res, rej) => {
          const mid = ++id;
          pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params }));
          setTimeout(() => {
            if (pending.has(mid)) { pending.delete(mid); rej(new Error('cdp timeout: ' + method)); }
          }, timeoutMs);
        });
      },
      close() { try { ws.close(); } catch (e) { /* ignore */ } }
    });
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
      }
    };
    ws.onerror = () => reject(new Error('websocket error'));
  });
}

async function waitReady(c, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await c.send('Runtime.evaluate', {
        expression: 'document.readyState + "|" + location.href', returnByValue: true
      }, 8000);
      const v = r && r.result && r.result.value ? String(r.result.value) : '';
      if (v.startsWith('complete|')) return v.slice(9);
    } catch (e) { /* 导航中，继续等 */ }
    await sleep(500);
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * URL 收集
 * ------------------------------------------------------------------ */

function collectUrls(opt) {
  const out = [...opt.url];
  for (const f of opt.urls) {
    if (!fs.existsSync(f)) { console.error(`[grab] 找不到 URL 文件: ${f}`); continue; }
    const raw = fs.readFileSync(f, 'utf8').trim();
    if (raw.startsWith('[')) {
      try { out.push(...JSON.parse(raw).map(String)); continue; }
      catch (e) { console.error(`[grab] ${f} 以 [ 开头但不是合法 JSON，按行解析`); }
    }
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      out.push(s);
    }
  }
  const seen = new Set();
  const uniq = out.filter((u) => u && /^(https?|file):\/\//i.test(u) && !seen.has(u) && seen.add(u));
  return opt.limit > 0 ? uniq.slice(0, opt.limit) : uniq;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

runMain(async () => {
  const { options: opt } = parseArgs(process.argv.slice(2), ARG_SPEC, { append: true });
  if (opt.help) { console.log(HELP); return; }

  const urls = collectUrls(opt);
  if (!urls.length) {
    console.error('没有可抓取的 URL。用 --urls <file> 或 --url <url> 指定。\n');
    console.log(HELP);
    process.exit(2);
  }

  let launched = null;
  if (opt.launch) {
    launched = await launchBrowser(opt.cdp);
    if (!launched) {
      const probe = await waitForCdp(opt.cdp, 1000);
      if (!probe) process.exit(1);
    }
  } else {
    const probe = await waitForCdp(opt.cdp, 800);
    if (!probe) {
      console.error(`[grab] CDP 不可达 ${opt.cdp}。请先启动浏览器（见 SKILL.md 3.1），或加 --launch。`);
      process.exit(1);
    }
  }

  const outPath = path.resolve(opt.out);
  ensureParent(opt.out);
  if (!opt.append) fs.writeFileSync(outPath, '');
  const writer = createJsonlWriter(opt.out);

  // 预热：先访问首页建立 cookie
  if (opt.warm) {
    try {
      const t = await newTab(opt.cdp, opt.warm);
      const c = await connect(t.webSocketDebuggerUrl);
      await sleep(4000);
      c.close();
      await closeTab(opt.cdp, t.id);
      console.error(`[grab] 预热完成: ${opt.warm}`);
    } catch (e) {
      console.error(`[grab] 预热失败（继续）: ${e.message}`);
    }
  }

  const expr = '(' + extractInPage.toString() + ')()';
  let okCount = 0, emptyCount = 0, failCount = 0;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const tag = `[${i + 1}/${urls.length}]`;
    let tab = null;
    try {
      tab = await newTab(opt.cdp, 'about:blank');
      const c = await connect(tab.webSocketDebuggerUrl);
      await c.send('Page.enable');
      await c.send('Page.navigate', { url });
      const finalUrl = await waitReady(c, opt.wait + 6000);
      await sleep(Math.max(800, opt.wait - 2000));

      const r = await c.send('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true
      }, 30000);
      const rec = r && r.result ? r.result.value : null;
      c.close();

      if (!rec || typeof rec !== 'object') {
        failCount++;
        console.error(`${tag} 抽取失败 NO_VALUE ${url}`);
      } else {
        const out = Object.assign({}, rec, {
          fetchedAt: new Date().toISOString(),
          sourceUrl: url
        });
        if (finalUrl && finalUrl !== url) out.finalUrl = finalUrl;
        if (!opt.raw) delete out.textHead;

        const filled = ['title', 'authors', 'journal', 'year', 'doi', 'abstract']
          .filter((k) => {
            const v = out[k];
            return Array.isArray(v) ? v.length : !!v;
          }).length;

        writer.write(out);
        if (filled >= 3) {
          okCount++;
          console.error(`${tag} OK  ${(out.title || '(无题名)').slice(0, 42)} | ${out.year || '-'} | ${out.doi ? 'DOI' : '无DOI'}`);
        } else {
          emptyCount++;
          console.error(`${tag} 字段偏少(${filled}/6) ${url} — 该页可能不是文章详情页或结构不同`);
        }
      }
    } catch (e) {
      failCount++;
      console.error(`${tag} ERROR ${e.message} :: ${url}`);
    } finally {
      if (tab) await closeTab(opt.cdp, tab.id);
    }
    if (i < urls.length - 1) await sleep(opt.delay);
  }

  await writer.end();

  console.error('\n[grab] 汇总');
  console.error(`  写入文件   ${outPath}`);
  console.error(`  抽取成功   ${okCount}`);
  console.error(`  字段偏少   ${emptyCount}`);
  console.error(`  失败       ${failCount}`);
  console.error(`  合计       ${urls.length}`);
  console.error(`\n  下一步：node cnki-export.js --input "${opt.out}" --out 文献清单.csv --format csv`);

  if (launched && !opt.keepOpen) {
    console.error(`\n[grab] 浏览器仍在后台运行（PID ${launched.pid}），用完请手动结束：`);
    console.error(`       taskkill /F /PID ${launched.pid}     # Windows`);
    console.error(`       kill ${launched.pid}                 # macOS / Linux`);
    console.error(`       profile 目录：${launched.profile}`);
  }
});
