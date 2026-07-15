#!/usr/bin/env node
// patch-cursor.mjs — 备份 Cursor main.js 并注入热重载流量捕获钩子
// 用法:
//   node patch-cursor.mjs patch            — 注入/升级钩子（含 bootstrap preload）
//   node patch-cursor.mjs unpatch          — 恢复 main.js + bootstrap
//   node patch-cursor.mjs status           — 检查当前状态
//   node patch-cursor.mjs detail-on|detail-off
//   node patch-cursor.mjs sync-hook
//   node patch-cursor.mjs patch-bootstrap  — 仅注入 bootstrap-fork preload
//   node patch-cursor.mjs unpatch-bootstrap

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CURSOR_APP = '/Applications/Cursor.app/Contents/Resources/app';
const MAIN_JS = path.join(CURSOR_APP, 'out', 'main.js');
const BOOTSTRAP_FORK_JS = path.join(CURSOR_APP, 'out', 'bootstrap-fork.js');
const BACKUP_DIR = path.join(os.homedir(), '.cursor-usage-tracker');
const BACKUP_FILE = path.join(BACKUP_DIR, 'main.js.bak');
const BOOTSTRAP_BACKUP_FILE = path.join(BACKUP_DIR, 'bootstrap-fork.js.bak');
const VERSION_FILE = path.join(BACKUP_DIR, 'patched-version.txt');
const DETAIL_FLAG = path.join(BACKUP_DIR, 'detail-logging.on');
const DETAIL_LOG = path.join(BACKUP_DIR, 'requests-detail.jsonl');
const HOOK_FILE = path.join(BACKUP_DIR, 'hook.mjs');
const PRELOAD_FILE = path.join(BACKUP_DIR, 'preload-intercept.cjs');
const HOOK_TEMPLATE = path.join(__dirname, 'hook.mjs');
const PRELOAD_TEMPLATE = path.join(__dirname, 'preload-intercept.cjs');

const HOOK_MARKER = '/* cursor-usage-tracker v0.3 */';
const HOOK_MARKER_PREFIX = '/* cursor-usage-tracker';
const BOOTSTRAP_PRELOAD_MARKER = '/* cursor-usage-tracker-preload v0.4 */';
const BOOTSTRAP_PRELOAD_MARKER_PREFIX = '/* cursor-usage-tracker-preload';

const HOOK_CODE = `${HOOK_MARKER}
Promise.all([import('electron'),import('node:fs'),import('node:path'),import('node:os')]).then(([electron,fs,path,os])=>{const{app,session}=electron;app.whenReady().then(()=>{try{const hookPath=path.join(os.homedir(),'.cursor-usage-tracker','hook.mjs');if(!fs.existsSync(hookPath)){console.error('[cursor-usage-tracker] missing hook.mjs');return}const deps={session,fs,path,os};let ver=0,current=null,timer=null;const load=async()=>{try{if(current&&current.teardown)current.teardown(deps);const mod=await import('file://'+hookPath+'?v='+(++ver));if(mod.setup)mod.setup(deps);current=mod;console.log('[cursor-usage-tracker] hook loaded v'+ver)}catch(e){console.error('[cursor-usage-tracker] load error',e)}};load();fs.watch(hookPath,{persistent:false},(ev)=>{if(ev!=='change'&&ev!=='rename')return;clearTimeout(timer);timer=setTimeout(load,300)})}catch(e){console.error('[cursor-usage-tracker]',e)}})}).catch(e=>console.error('[cursor-usage-tracker]',e));
`;

const BOOTSTRAP_PRELOAD_CODE = `${BOOTSTRAP_PRELOAD_MARKER}
import{createRequire as __cutCreateRequire}from"node:module";import{homedir as __cutHomedir}from"node:os";import{join as __cutJoin}from"node:path";try{__cutCreateRequire(import.meta.url)(__cutJoin(__cutHomedir(),".cursor-usage-tracker","preload-intercept.cjs"))}catch(e){console.error("[cursor-usage-tracker] preload",e)}
`;

function getCursorVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(CURSOR_APP, 'package.json'), 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function findHookRange(content) {
  const start = content.indexOf(HOOK_MARKER_PREFIX);
  if (start === -1) return null;
  const firstNl = content.indexOf('\n', start);
  const secondNl = content.indexOf('\n', firstNl + 1);
  if (firstNl === -1 || secondNl === -1) return null;
  return { start, end: secondNl + 1 };
}

function findBootstrapPreloadRange(content) {
  const start = content.indexOf(BOOTSTRAP_PRELOAD_MARKER_PREFIX);
  if (start === -1) return null;
  const firstNl = content.indexOf('\n', start);
  const secondNl = content.indexOf('\n', firstNl + 1);
  if (firstNl === -1 || secondNl === -1) return null;
  return { start, end: secondNl + 1 };
}

function isPatched() {
  try {
    return fs.readFileSync(MAIN_JS, 'utf8').includes(HOOK_MARKER_PREFIX);
  } catch {
    return false;
  }
}

function isCurrent() {
  try {
    return fs.readFileSync(MAIN_JS, 'utf8').includes(HOOK_MARKER);
  } catch {
    return false;
  }
}

function isBootstrapPatched() {
  try {
    return fs.readFileSync(BOOTSTRAP_FORK_JS, 'utf8').includes(BOOTSTRAP_PRELOAD_MARKER_PREFIX);
  } catch {
    return false;
  }
}

function isBootstrapCurrent() {
  try {
    return fs.readFileSync(BOOTSTRAP_FORK_JS, 'utf8').includes(BOOTSTRAP_PRELOAD_MARKER);
  } catch {
    return false;
  }
}

function ensureCaptureFiles({ force = false } = {}) {
  if (!fs.existsSync(HOOK_TEMPLATE) || !fs.existsSync(PRELOAD_TEMPLATE)) {
    console.error('✗ 缺少 hook.mjs 或 preload-intercept.cjs');
    return false;
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const hookTemplate = fs.readFileSync(HOOK_TEMPLATE, 'utf8');
  if (!force && fs.existsSync(HOOK_FILE) && fs.readFileSync(HOOK_FILE, 'utf8') === hookTemplate) {
    console.log('✓ hook.mjs 已是最新');
  } else {
    fs.writeFileSync(HOOK_FILE, hookTemplate);
    console.log('✓ 已写入 hook.mjs');
  }
  const preloadTemplate = fs.readFileSync(PRELOAD_TEMPLATE, 'utf8');
  if (
    !force &&
    fs.existsSync(PRELOAD_FILE) &&
    fs.readFileSync(PRELOAD_FILE, 'utf8') === preloadTemplate
  ) {
    console.log('✓ preload-intercept.cjs 已是最新');
  } else {
    fs.writeFileSync(PRELOAD_FILE, preloadTemplate);
    console.log('✓ 已写入 preload-intercept.cjs');
  }
  return true;
}

function patchBootstrap({ quiet = false } = {}) {
  if (!ensureCaptureFiles()) process.exit(1);
  if (!fs.existsSync(BOOTSTRAP_FORK_JS)) {
    console.error(`✗ 找不到 ${BOOTSTRAP_FORK_JS}`);
    process.exit(1);
  }
  if (isBootstrapCurrent()) {
    if (!quiet) console.log('✓ bootstrap-fork.js 已是最新 preload 注入');
    return;
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (!isBootstrapPatched() && !fs.existsSync(BOOTSTRAP_BACKUP_FILE)) {
    fs.copyFileSync(BOOTSTRAP_FORK_JS, BOOTSTRAP_BACKUP_FILE);
    console.log(`备份: ${BOOTSTRAP_BACKUP_FILE}`);
  }
  const original = fs.readFileSync(BOOTSTRAP_FORK_JS, 'utf8');
  const range = findBootstrapPreloadRange(original);
  let patched;
  if (range) {
    patched =
      original.slice(0, range.start) + BOOTSTRAP_PRELOAD_CODE + '\n' + original.slice(range.end);
  } else {
    const commentEnd = original.indexOf('*/');
    if (commentEnd === -1) {
      console.error('✗ bootstrap-fork.js 无版权注释');
      process.exit(1);
    }
    patched =
      original.slice(0, commentEnd + 2) +
      '\n' +
      BOOTSTRAP_PRELOAD_CODE +
      original.slice(commentEnd + 2);
  }
  fs.writeFileSync(BOOTSTRAP_FORK_JS, patched);
  console.log('✓ bootstrap-fork.js 已注入 preload（always-local Extension Host 必需）');
  if (!quiet) console.log('⚠ 请完全重启 Cursor');
}

function patch() {
  if (!ensureCaptureFiles()) process.exit(1);
  patchBootstrap({ quiet: true });

  if (isCurrent()) {
    console.log('✓ main.js loader 已是最新 (v0.3)');
    console.log('⚠ 请完全重启 Cursor，使 always-local 加载 bootstrap preload');
    return;
  }

  const version = getCursorVersion();
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (!isPatched()) {
    fs.copyFileSync(MAIN_JS, BACKUP_FILE);
    console.log(`备份: ${BACKUP_FILE}`);
  }
  fs.writeFileSync(VERSION_FILE, version);
  const original = fs.readFileSync(MAIN_JS, 'utf8');
  const range = findHookRange(original);
  let patched;
  if (range) {
    patched = original.slice(0, range.start) + HOOK_CODE + '\n' + original.slice(range.end);
  } else {
    const commentEnd = original.indexOf('*/');
    if (commentEnd === -1) {
      console.error('✗ 无法找到版权注释');
      process.exit(1);
    }
    patched = original.slice(0, commentEnd + 2) + '\n' + HOOK_CODE + original.slice(commentEnd + 2);
  }
  fs.writeFileSync(MAIN_JS, patched);
  console.log('✓ Patch 成功；请完全重启 Cursor');
}

function unpatchBootstrap() {
  if (!isBootstrapPatched()) {
    console.log('bootstrap 未注入');
    return;
  }
  if (fs.existsSync(BOOTSTRAP_BACKUP_FILE)) {
    fs.copyFileSync(BOOTSTRAP_BACKUP_FILE, BOOTSTRAP_FORK_JS);
  } else {
    const content = fs.readFileSync(BOOTSTRAP_FORK_JS, 'utf8');
    const range = findBootstrapPreloadRange(content);
    if (!range) {
      console.error('✗ 无法定位 bootstrap preload');
      process.exit(1);
    }
    fs.writeFileSync(BOOTSTRAP_FORK_JS, content.slice(0, range.start) + content.slice(range.end));
  }
  console.log('✓ bootstrap preload 已移除');
}

function unpatch() {
  if (isBootstrapPatched()) unpatchBootstrap();
  if (!isPatched()) {
    console.log('main.js 未 patch');
    return;
  }
  if (fs.existsSync(BACKUP_FILE)) {
    fs.copyFileSync(BACKUP_FILE, MAIN_JS);
  } else {
    const content = fs.readFileSync(MAIN_JS, 'utf8');
    const range = findHookRange(content);
    if (!range) {
      console.error('✗ 无法定位 hook');
      process.exit(1);
    }
    fs.writeFileSync(MAIN_JS, content.slice(0, range.start) + content.slice(range.end));
  }
  console.log('✓ Unpatch 成功；请重启 Cursor');
}

function status() {
  console.log(`Cursor 版本:    ${getCursorVersion()}`);
  console.log(
    `main.js:        ${isPatched() ? (isCurrent() ? '✓ v0.3' : '⚠ 旧版') : '✗ 未 patch'}`
  );
  console.log(
    `bootstrap注入:  ${isBootstrapPatched()
      ? isBootstrapCurrent()
        ? '✓ v0.4（always-local 必需）'
        : '⚠ 旧版'
      : '✗ 未注入 — EH 抓不到正文'
    }`
  );
  console.log(`hook/preload:   ${fs.existsSync(HOOK_FILE) && fs.existsSync(PRELOAD_FILE) ? '✓' : '✗'}`);
  console.log(`明细记录:       ${fs.existsSync(DETAIL_FLAG) ? '✓' : '✗'}`);
  const logFile = path.join(BACKUP_DIR, 'requests.jsonl');
  if (fs.existsSync(logFile)) {
    console.log(
      `用量日志:       ${fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).length} 条`
    );
  }
  if (fs.existsSync(DETAIL_LOG)) {
    console.log(
      `明细日志:       ${fs.readFileSync(DETAIL_LOG, 'utf8').trim().split('\n').filter(Boolean).length} 条`
    );
  }
}

function detailOn() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.writeFileSync(DETAIL_FLAG, '1\n');
  console.log('✓ 明细已开启 →', DETAIL_LOG);
}

function detailOff() {
  if (fs.existsSync(DETAIL_FLAG)) fs.unlinkSync(DETAIL_FLAG);
  console.log('✓ 明细已关闭');
}

function syncHook() {
  if (!ensureCaptureFiles({ force: true })) process.exit(1);
  console.log('  若改了 preload：重启 Cursor（bootstrap 在进程启动时 require）');
}

const cmd = process.argv[2] || 'status';
switch (cmd) {
  case 'patch':
    patch();
    break;
  case 'unpatch':
    unpatch();
    break;
  case 'status':
    status();
    break;
  case 'detail-on':
    detailOn();
    break;
  case 'detail-off':
    detailOff();
    break;
  case 'sync-hook':
    syncHook();
    break;
  case 'patch-bootstrap':
    patchBootstrap();
    break;
  case 'unpatch-bootstrap':
    unpatchBootstrap();
    break;
  default:
    console.log(
      '用法: node patch-cursor.mjs [patch|unpatch|status|detail-on|detail-off|sync-hook|patch-bootstrap|unpatch-bootstrap]'
    );
}
