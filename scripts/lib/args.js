'use strict';

/**
 * Minimal, dependency-free argument parser shared by the skill scripts.
 *
 * spec:
 *   flag: {
 *     key, type: 'boolean'|'value'|'number'|'csv',
 *     multiple, min, max, choices, default
 *   }
 */
function parseArgs(argv, spec, init = {}) {
  const out = Object.assign({}, init);
  const aliases = new Map();

  for (const [flag, raw] of Object.entries(spec)) {
    const cfg = Object.assign({ key: flag.replace(/^-+/, '') }, raw);
    aliases.set(flag, cfg);
    if (cfg.default !== undefined && out[cfg.key] === undefined) out[cfg.key] = cfg.default;
  }

  const positionals = [];
  let positionalOnly = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (positionalOnly || arg === '-' || !arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      positionalOnly = true;
      continue;
    }

    const cfg = aliases.get(arg);
    if (!cfg) throw usageError(`未知参数: ${arg}`);

    if (cfg.type === 'boolean') {
      out[cfg.key] = true;
      continue;
    }

    if (i + 1 >= argv.length) throw usageError(`参数 ${arg} 缺少值`);
    const value = argv[++i];
    let parsed;

    if (cfg.type === 'number') {
      parsed = Number(value);
      if (!Number.isFinite(parsed) || (cfg.integer !== false && !Number.isInteger(parsed))) {
        throw usageError(`参数 ${arg} 需要数字，收到: ${value}`);
      }
      if (cfg.min !== undefined && parsed < cfg.min) throw usageError(`参数 ${arg} 不能小于 ${cfg.min}`);
      if (cfg.max !== undefined && parsed > cfg.max) throw usageError(`参数 ${arg} 不能大于 ${cfg.max}`);
    } else if (cfg.type === 'csv') {
      parsed = String(value).split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      parsed = String(value);
    }

    if (cfg.choices && !cfg.choices.includes(parsed)) {
      throw usageError(`参数 ${arg} 不支持 ${parsed}；可选: ${cfg.choices.join(', ')}`);
    }

    if (cfg.multiple || cfg.type === 'csv') {
      const current = Array.isArray(out[cfg.key]) ? out[cfg.key].slice() : [];
      out[cfg.key] = current.concat(Array.isArray(parsed) ? parsed : [parsed]);
    } else {
      out[cfg.key] = parsed;
    }
  }

  return { options: out, positionals };
}

function usageError(message) {
  const err = new Error(message);
  err.code = 'USAGE';
  return err;
}

function runMain(main) {
  Promise.resolve()
    .then(main)
    .catch((err) => {
      if (err && err.code === 'USAGE') {
        console.error(err.message);
        process.exit(2);
      }
      console.error('ERR: ' + (err && err.stack || err));
      process.exit(1);
    });
}

module.exports = { parseArgs, usageError, runMain };
