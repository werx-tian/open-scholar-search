#!/usr/bin/env node
/**
 * cdp-fetch.js — 通过 CDP 驱动已启动的浏览器抓取渲染后的页面内容
 *
 * 前置：
 *   1) 以 run_in_background 常驻启动 Edge/Chrome：
 *      msedge.exe --headless=new --disable-gpu --remote-debugging-port=9222 \
 *        --user-data-dir="<tmp>" --no-first-run --no-default-browser-check about:blank
 *   2) 建议先访问目标站点首页建立 cookie，再访问深层页面
 *
 * 用法：
 *   node cdp-fetch.js "<url>" [waitMs] ["<js表达式>"]
 *
 * 示例：
 *   node cdp-fetch.js "https://www.cnki.net/" 8000 "document.title"
 *   node cdp-fetch.js "https://example.com/a" 12000 "document.body.innerText.slice(0,3000)"
 *   # 批量：
 *   node cdp-fetch.js '[ "https://a.com","https://b.com" ]' 10000 "document.title"
 */
const { parseArgs, runMain } = require('./lib/args');

const ARG_SPEC = {
  '--wait': { key: 'wait', type: 'number', integer: true, min: 0 },
  '--expr': { key: 'expr' },
  '--cdp': { key: 'cdp', default: process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222' },
  '--help': { key: 'help', type: 'boolean', default: false },
  '-h': { key: 'help', type: 'boolean' }
};
let CDP = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function newTab(url) {
  const r = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!r.ok) throw new Error(`/json/new HTTP ${r.status}`);
  return await r.json();
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
            if (pending.has(mid)) { pending.delete(mid); rej(new Error(`cdp timeout: ${method}`)); }
          }, timeoutMs);
        });
      },
      close() { try { ws.close(); } catch (e) {} }
    });
    ws.onmessage = ev => {
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

runMain(async () => {
  const { options, positionals } = parseArgs(process.argv.slice(2), ARG_SPEC);
  if (options.help) {
    console.log('usage: node cdp-fetch.js "<url>" [waitMs] ["<js>"] [--cdp endpoint]');
    return;
  }
  const raw = positionals[0];
  if (!raw) throw new Error('缺少 URL');
  CDP = options.cdp;
  const urls = raw.trim().startsWith('[') ? JSON.parse(raw) : [raw];
  const waitMs = options.wait ?? (parseInt(positionals[1] || '10000', 10));
  const expr = options.expr || positionals[2] || "document.title + '\\n' + document.body.innerText.slice(0,4000)";

  const tab = await newTab('about:blank');
  const c = await connect(tab.webSocketDebuggerUrl);
  await c.send('Page.enable');

  for (const u of urls) {
    try { await c.send('Page.navigate', { url: u }); }
    catch (e) { console.log(`NAV_ERR ${u} :: ${e.message}`); continue; }
    await sleep(waitMs);
    try {
      const r = await c.send('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true
      });
      console.log(`===== ${u} =====`);
      console.log(r && r.result ? r.result.value : '(no value)');
      console.log('');
    } catch (e) {
      console.log(`===== ${u} =====`);
      console.log('EVAL_ERR: ' + e.message);
    }
  }
  c.close();
});
