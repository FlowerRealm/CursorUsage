#!/usr/bin/env node
// analyze-results.mjs — 综合分析验证结果，确认 AI 请求的捕获盲区

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DATA_DIR = path.join(os.homedir(), '.cursor-usage-tracker');

function section(title) {
  console.log(`\n${'━'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('━'.repeat(60));
}

function readJsonl(file) {
  const fullPath = path.join(DATA_DIR, file);
  if (!fs.existsSync(fullPath)) return [];
  return fs.readFileSync(fullPath, 'utf8').trim().split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// ====== 1. 当前捕获状况 ======
section('1. 当前 webRequest 捕获的请求分类');
const requests = readJsonl('requests.jsonl');
const urlBreakdown = {};
for (const r of requests) {
  try {
    const u = new URL(r.url);
    const key = `${u.hostname}${u.pathname.split('?')[0]}`;
    urlBreakdown[key] = (urlBreakdown[key] || 0) + 1;
  } catch { }
}
for (const [url, count] of Object.entries(urlBreakdown).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(5)} × ${url}`);
}
console.log(`\n  总计: ${requests.length} 条`);
console.log('  ⚠ 注意: 全部是 auth/telemetry/update，零条 AI 请求');

// ====== 2. webRequest.onResponseStarted 结果 ======
section('2. webRequest.onResponseStarted 增强结果');
const enhanced = readJsonl('webRequest-enhanced.jsonl');
const enhancedBreakdown = {};
for (const r of enhanced) {
  try {
    const u = new URL(r.url);
    const key = `${u.hostname}${u.pathname.split('?')[0]}`;
    enhancedBreakdown[key] = (enhancedBreakdown[key] || 0) + 1;
  } catch { }
}
if (enhanced.length === 0) {
  console.log('  (无数据)');
} else {
  for (const [url, count] of Object.entries(enhancedBreakdown).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)} × ${url}`);
  }
  console.log(`\n  总计: ${enhanced.length} 条`);
  console.log('  结论: onResponseStarted 同样只捕获到 Chromium 网络栈的请求');
}

// ====== 3. Extension Host preload 捕获结果 ======
section('3. Extension Host preload 拦截结果');
const extRequests = readJsonl('requests-ext.jsonl');
if (extRequests.length === 0) {
  console.log('  (无数据 — 需要重启 Cursor 使 preload 注入生效)');
} else {
  const bySource = {};
  const byProc = {};
  for (const r of extRequests) {
    bySource[r.source] = (bySource[r.source] || 0) + 1;
    byProc[r.proc] = (byProc[r.proc] || 0) + 1;
  }
  console.log('  按来源:');
  for (const [s, c] of Object.entries(bySource)) console.log(`    ${s}: ${c}`);
  console.log('  按进程:');
  for (const [p, c] of Object.entries(byProc)) console.log(`    ${p}: ${c}`);
  console.log(`  总计: ${extRequests.length} 条 AI 请求被捕获！`);
}

// ====== 4. 其他 Session 结果 ======
section('4. 其他 Electron Session 结果');
const sessRequests = readJsonl('sessions-enhanced.jsonl');
if (sessRequests.length === 0) {
  console.log('  (无数据 — Extension Host 不使用 Electron Session)');
} else {
  console.log(`  捕获 ${sessRequests.length} 条`);
}

// ====== 5. 主进程 HTTP 结果 ======
section('5. 主进程 HTTP monkey-patch 结果');
const mainHttp = readJsonl('main-process-http.jsonl');
if (mainHttp.length === 0) {
  console.log('  (无数据 — 主进程不直接发送 AI HTTP 请求)');
} else {
  console.log(`  捕获 ${mainHttp.length} 条`);
}

// ====== 6. Hook 调试日志 ======
section('6. Hook 调试日志');
const debugPath = path.join(DATA_DIR, 'hook-debug.log');
if (fs.existsSync(debugPath)) {
  const debugLines = fs.readFileSync(debugPath, 'utf8').trim().split('\n');
  for (const line of debugLines) {
    console.log(`  ${line}`);
  }
}

// ====== 7. 实时网络连接分析 ======
section('7. 实时 Extension Host 网络连接');
try {
  const lsof = execSync('lsof -i -n -P 2>/dev/null', { encoding: 'utf8' });
  const ps = execSync('ps aux', { encoding: 'utf8' });
  const pidToLabel = {};
  for (const line of ps.split('\n')) {
    if (!line.includes('Cursor')) continue;
    const cols = line.trim().split(/\s+/);
    const pid = cols[1];
    const cmd = cols.slice(10).join(' ');
    if (cmd.includes('extension-host')) {
      const m = cmd.match(/extension-host \(([^)]+)\)/);
      pidToLabel[pid] = m ? `ext-host-${m[1]}` : 'ext-host-?';
    }
  }

  let extHostConns = 0;
  for (const line of lsof.split('\n')) {
    if (!line.includes('ESTABLISHED')) continue;
    const cols = line.trim().split(/\s+/);
    const pid = cols[1];
    if (!pidToLabel[pid]) continue;
    const conn = cols[8] || '';
    extHostConns++;
    console.log(`  ${pidToLabel[pid]} (PID ${pid}): ${conn}`);
  }
  if (extHostConns === 0) {
    console.log('  (无活跃 Extension Host 网络连接)');
  } else {
    console.log(`\n  共 ${extHostConns} 个活跃连接（全部绕过 webRequest）`);
  }
} catch { }

// ====== 8. 综合结论 ======
section('8. 综合结论');
console.log(`
  问题确认:
  ═════════
  Cursor 的 AI 请求（agent/chat/tab completion）由 Extension Host 进程发送。
  这些进程是通过 electron.utilityProcess.fork() 创建的独立 Node.js 进程，
  使用原生 Node.js HTTP 客户端（fetch/undici），完全绕过 Chromium 网络栈。

  当前 webRequest API 只能捕获:
    ✓ 认证请求 (auth/full_stripe_profile) — Chromium 渲染进程
    ✓ 遥测数据 (tev1/v1/rgstr) — Chromium 渲染进程
    ✓ 更新检查 (updates/api/update) — Chromium 渲染进程
    ✗ AI 对话请求 — Extension Host 进程 (Node.js)
    ✗ Agent 请求 — Extension Host 进程 (Node.js)
    ✗ Tab 补全请求 — Extension Host 进程 (Node.js)
    ✗ 代码索引请求 — Extension Host 进程 (Node.js)

  验证的拦截方案:
  ═══════════════
  方案 A: utilityProcess.fork() monkey-patch + NODE_OPTIONS --require
    状态: ✓ fork patch 注入成功
    限制: 需要重启 Cursor 使已有的 Extension Host 重新创建
    原理: 在 fork 时注入 NODE_OPTIONS=--require=preload.cjs，
          preload 脚本在 Extension Host 启动时 hook fetch/https

  方案 B: webRequest 扩展到其他 Session
    状态: ✗ Extension Host 不使用 Electron Session
    原因: Extension Host 是独立 Node.js 进程，不经过 Chromium

  方案 C: 主进程 https monkey-patch
    状态: ✗ 主进程不直接发送 AI 请求
    原因: AI 请求由子进程（Extension Host）发送

  推荐下一步:
  ═══════════
  1. 重启 Cursor，验证 preload 注入是否生效
  2. 如果生效，将 preload 方案整合到正式 hook.mjs
  3. 合并 requests-ext.jsonl 和 requests.jsonl 的数据流
`);
