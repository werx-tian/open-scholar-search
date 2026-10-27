'use strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function userAgent(email) {
  return 'open-scholar-search/2.0 (academic use' + (email ? '; mailto:' + email : '') + ')';
}

async function getText(url, options = {}, label = 'HTTP') {
  const maxRetries = Number.isInteger(options.retries) ? options.retries : 2;
  const timeout = Number.isFinite(options.timeout) ? options.timeout : 25000;
  let lastError = '';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': userAgent(options.email),
          Accept: options.accept || 'application/json,application/atom+xml,application/xml,text/xml,*/*',
          ...(options.coreKey && /api\.core\.ac\.uk/.test(url)
            ? { Authorization: 'Bearer ' + options.coreKey }
            : {})
        }
      });
      const body = await response.text();
      if (response.ok) return { ok: true, status: response.status, body, attempts: attempt + 1 };

      lastError = `HTTP ${response.status} ${body.slice(0, 180)}`;
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      if (!retryable || attempt === maxRetries) break;
      const retryAfter = Number(response.headers.get('retry-after') || 0);
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 500 * (2 ** attempt));
    } catch (err) {
      lastError = err && err.name === 'AbortError' ? `${label} 超时` : String(err && err.message || err);
      if (attempt === maxRetries) break;
      await sleep(500 * (2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, status: 'ERR', body: '', error: lastError || 'unknown', attempts: maxRetries + 1 };
}

async function getJSON(url, options = {}, label = 'HTTP') {
  const result = await getText(url, options, label);
  if (!result.ok) return result;
  try {
    return { ...result, json: JSON.parse(result.body) };
  } catch (err) {
    return { ...result, ok: false, error: `${label} 返回非 JSON: ${err.message}` };
  }
}

/** Per-source limiter. Five record workers still share one sequential stream per API. */
class RateLimiter {
  constructor({ minInterval = 0, maxConcurrent = 1 } = {}) {
    this.minInterval = minInterval;
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.active = 0;
    this.lastStart = 0;
    this.queue = [];
    this.timer = null;
  }

  run(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this._drain();
    });
  }

  _drain() {
    if (this.timer || this.active >= this.maxConcurrent || !this.queue.length) return;
    const wait = Math.max(0, this.lastStart + this.minInterval - Date.now());
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this._drain();
      }, wait);
      return;
    }

    const job = this.queue.shift();
    this.active++;
    this.lastStart = Date.now();
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => {
        this.active--;
        this._drain();
      });
  }
}

const limiters = new Map();

function limiterFor(name, settings) {
  if (!limiters.has(name)) limiters.set(name, new RateLimiter(settings));
  return limiters.get(name);
}

async function mapLimit(items, concurrency, worker) {
  const list = Array.from(items);
  const results = new Array(list.length);
  let next = 0;

  async function consume() {
    while (true) {
      const index = next++;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  }

  await Promise.all(Array.from(
    { length: Math.max(1, Math.min(concurrency || 1, list.length || 1)) },
    consume
  ));
  return results;
}

module.exports = { sleep, getText, getJSON, RateLimiter, limiterFor, mapLimit };
