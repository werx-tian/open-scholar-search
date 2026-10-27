'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Read JSONL, NDJSON, or a JSON array without dropping source-specific fields.
 * In particular, expansionLevel, _warnings, provenance, and ranking metadata are
 * preserved because downstream stages intentionally merge rather than whitelist.
 */
function readRecords(files, options = {}) {
  const label = options.label || 'data';
  const records = [];
  let fileCount = 0;
  let badLines = 0;

  for (const file of files) {
    if (!fs.existsSync(file)) {
      console.error(`[${label}] 找不到输入文件: ${file}`);
      continue;
    }
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) continue;
    fileCount++;

    if (raw.startsWith('[')) {
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error('顶层不是数组');
        for (const item of parsed) {
          if (item && typeof item === 'object') records.push(item);
        }
        continue;
      } catch (err) {
        console.error(`[${label}] ${file} JSON 数组解析失败，回退为 JSONL: ${err.message}`);
      }
    }

    for (const line of raw.split(/\r?\n/)) {
      const text = line.trim().replace(/,$/, '');
      if (!text || text === '[' || text === ']') continue;
      try {
        const item = JSON.parse(text);
        if (item && typeof item === 'object') records.push(item);
      } catch (err) {
        badLines++;
      }
    }
  }

  if (badLines) console.error(`[${label}] 跳过无法解析的行: ${badLines}`);
  if (options.verbose !== false) {
    console.error(`[${label}] 读入 ${records.length} 条记录（来自 ${fileCount} 个文件）`);
  }
  return records;
}

function ensureParent(file) {
  if (!file || file === '-') return;
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
}

function writeJsonl(records, out, options = {}) {
  const text = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  if (out === '-') {
    process.stdout.write(text);
    return;
  }
  ensureParent(out);
  if (options.append) fs.appendFileSync(path.resolve(out), text, 'utf8');
  else fs.writeFileSync(path.resolve(out), text, 'utf8');
}

function createJsonlWriter(out) {
  if (out === '-') {
    return {
      write(record) { process.stdout.write(JSON.stringify(record) + '\n'); },
      async end() {}
    };
  }
  ensureParent(out);
  const stream = fs.createWriteStream(path.resolve(out), { flags: 'a' });
  return {
    write(record) { stream.write(JSON.stringify(record) + '\n'); },
    end() { return new Promise((resolve, reject) => {
      stream.end(resolve);
      stream.on('error', reject);
    }); }
  };
}

function warningRecord(source, error, context = {}) {
  return {
    recordType: 'warning',
    title: '',
    source,
    _warnings: [{
      source,
      error: String(error || 'unknown'),
      time: new Date().toISOString(),
      ...context
    }]
  };
}

module.exports = { readRecords, writeJsonl, createJsonlWriter, warningRecord, ensureParent };
