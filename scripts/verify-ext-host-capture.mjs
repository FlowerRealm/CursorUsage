#!/usr/bin/env node
// scripts/verify-ext-host-capture.mjs — 验证 Extension Host AI 捕获（主路径 + AI-only）

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const DATA = path.join(os.homedir(), '.cursor-usage-tracker');
const LOG = path.join(DATA, 'requests.jsonl');
const PRELOAD_DEBUG = path.join(DATA, 'preload-debug.log');
const HOOK_DEBUG = path.join(DATA, 'hook-debug.log');
const PRELOAD = path.join(DATA, 'preload-intercept.cjs');
const BOOTSTRAP = '/Applications/Cursor.app/Contents/Resources/app/out/bootstrap-fork.js';

function section(t) {
  console.log(`\n=== ${t} ===`);
}

section('Files');
for (const f of [PRELOAD, LOG, HOOK_DEBUG, PRELOAD_DEBUG]) {
  console.log(`${fs.existsSync(f) ? '✓' : '✗'} ${f}`);
}

section('Bootstrap (must NOT be patched)');
try {
  const boot = fs.readFileSync(BOOTSTRAP, 'utf8');
  console.log(
    boot.includes('cursor-usage-tracker-preload')
      ? '✗ bootstrap-fork.js still has preload inject — run unpatch-bootstrap leftover cleanup'
      : '✓ bootstrap-fork.js clean (primary fork path only)'
  );
} catch (e) {
  console.log('?', e.message);
}

section('Hook debug (fork patch)');
if (fs.existsSync(HOOK_DEBUG)) {
  for (const l of fs.readFileSync(HOOK_DEBUG, 'utf8').trim().split('\n').slice(-8)) {
    console.log(l);
  }
}

section('Preload debug');
if (fs.existsSync(PRELOAD_DEBUG)) {
  const lines = fs.readFileSync(PRELOAD_DEBUG, 'utf8').trim().split('\n');
  console.log(`lines: ${lines.length}`);
  for (const l of lines.slice(-10)) console.log(l);
} else {
  console.log('✗ missing — restart Cursor so Extension Host loads preload');
}

section('AI-only log check (entries with category)');
if (fs.existsSync(LOG)) {
  const entries = fs
    .readFileSync(LOG, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const withCat = entries.filter((e) => e.category);
  const byCat = {};
  for (const e of withCat) byCat[e.category] = (byCat[e.category] || 0) + 1;
  console.log(`entries with category field: ${withCat.length}`);
  console.log(byCat);
  const bad = withCat.filter((e) => !['chat', 'agent', 'tab'].includes(e.category));
  if (bad.length) {
    console.log(`✗ non-AI categories logged: ${bad.length}`);
  } else if (withCat.length) {
    console.log('✓ all categorized entries are chat/agent/tab');
  }
  const recent = withCat.slice(-3);
  if (recent.length) console.log('latest:', JSON.stringify(recent, null, 2));
}

section('Self-test preload');
try {
  execSync(`node --require ${JSON.stringify(PRELOAD)} -e ${JSON.stringify("console.log('ok')")}`, {
    encoding: 'utf8',
    timeout: 5000
  });
  console.log('✓ --require works');
} catch (e) {
  console.log('✗', e.message);
}

section('Verdict');
const hasExt =
  fs.existsSync(LOG) &&
  (fs.readFileSync(LOG, 'utf8').includes('"source":"ext-host"') ||
    fs.readFileSync(LOG, 'utf8').includes('"category":"chat"'));
const hasPreloadLog = fs.existsSync(PRELOAD_DEBUG);
if (hasExt && hasPreloadLog) {
  console.log('PASS');
  process.exit(0);
} else if (hasPreloadLog) {
  console.log('PARTIAL — preload loaded, trigger a chat/agent request');
  process.exit(2);
} else {
  console.log('PENDING — restart Cursor');
  process.exit(3);
}
