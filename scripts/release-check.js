#!/usr/bin/env node
/**
 * release-check.js — fail if public source contains likely private material.
 *
 * This intentionally checks text files only. Runtime outputs and Git internals are
 * excluded so generated records do not create false positives.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'output']);
const SKIP_FILES = new Set(['release-check.js']);

const rules = [
  {
    name: 'private key',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
  },
  {
    name: 'GitHub token',
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/
  },
  {
    name: 'bearer token',
    regex: /\bBearer\s+[A-Za-z0-9._-]{20,}/i
  },
  {
    name: 'personal home path',
    regex: /(?:[A-Za-z]:\\Users\\[^\\\s]+|\/Users\/[^/\s]+|\/home\/[^/\s]+)/i
  },
  {
    name: 'private runtime path',
    regex: /\.workbuddy/i
  },
  {
    name: 'non-placeholder email',
    regex: /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi,
    allow: (match, domain) => /(?:^|\.)example\.(?:com|org|edu)$/i.test(domain)
  },
  {
    name: 'non-loopback IP address',
    regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    allow: (match) => /^(?:127\.|0\.0\.0\.0$|255\.255\.255\.255$)/.test(match)
  }
];

function isText(buffer) {
  return !buffer.subarray(0, 4096).includes(0);
}

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile() && !SKIP_FILES.has(entry.name)) files.push(full);
  }
  return files;
}

const findings = [];
for (const file of walk(ROOT)) {
  const buffer = fs.readFileSync(file);
  if (!isText(buffer)) continue;
  const text = buffer.toString('utf8');

  for (const rule of rules) {
    rule.regex.lastIndex = 0;
    let match;
    while ((match = rule.regex.exec(text)) !== null) {
      const allowed = rule.allow && rule.allow(match[0], ...match.slice(1));
      if (allowed) continue;
      const before = text.slice(0, match.index);
      const line = before.split(/\r?\n/).length;
      findings.push({
        file: path.relative(ROOT, file),
        line,
        rule: rule.name
      });
    }
  }

  const localUser = process.env.CI ? '' : String(process.env.USERNAME || process.env.USER || '').trim();
  if (localUser.length >= 3) {
    const escaped = localUser.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const userRe = new RegExp(`\\b${escaped}\\b`, 'gi');
    let match;
    while ((match = userRe.exec(text)) !== null) {
      const before = text.slice(0, match.index);
      const line = before.split(/\r?\n/).length;
      findings.push({ file: path.relative(ROOT, file), line, rule: 'local username' });
    }
  }
}

if (findings.length) {
  console.error(`[release-check] FAIL: ${findings.length} likely private value(s)`);
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}  ${finding.rule}`);
  }
  process.exit(1);
}

console.log('[release-check] PASS: no private paths, real emails, private keys, or access tokens detected');
