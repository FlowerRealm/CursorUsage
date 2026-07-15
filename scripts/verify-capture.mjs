#!/usr/bin/env node
// verify-capture.mjs — 验证 Cursor AI 请求的实际走向
// 通过多种方式分析：lsof 网络连接、已有日志对比、TLS 证书检查

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DATA_DIR = path.join(os.homedir(), '.cursor-usage-tracker');
const LOG_FILE = path.join(DATA_DIR, 'requests.jsonl');

function section(title) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

function getCursorPids() {
  try {
    const out = execSync('ps aux', { encoding: 'utf8' });
    const pids = {};
    for (const line of out.split('\n')) {
      if (!line.includes('Cursor') || line.includes('CursorUsage') || line.includes('CursorUIViewService')) continue;
      const cols = line.trim().split(/\s+/);
      const pid = cols[1];
      const cmd = cols.slice(10).join(' ');
      let label = 'unknown';
      if (cmd.includes('--type=utility') && cmd.includes('network.mojom.NetworkService')) label = 'chromium-network';
      else if (cmd.includes('extension-host (always-local)') || cmd.includes('always-local')) label = 'ext-host-local';
      else if (cmd.includes('extension-host (agent-exec)') || cmd.includes('agent-exec')) label = 'ext-host-agent';
      else if (cmd.includes('extension-host (retrieval)') || cmd.includes('retrieval')) label = 'ext-host-retrieval';
      else if (cmd.includes('shared-process')) label = 'shared-process';
      else if (cmd.includes('mcp-process')) label = 'mcp-process';
      else if (cmd.includes('--type=renderer')) label = 'renderer';
      else if (cmd.includes('--type=gpu')) label = 'gpu';
      else if (cmd.includes('MacOS/Cursor') && !cmd.includes('Helper')) label = 'main-process';
      else if (cmd.includes('pty-host')) label = 'pty-host';
      else if (cmd.includes('fileWatcher')) label = 'file-watcher';
      else if (cmd.includes('crashpad')) label = 'crashpad';
      else if (cmd.includes('Plugin')) label = 'plugin-other';
      pids[pid] = label;
    }
    return pids;
  } catch { return {}; }
}

function getNetworkConnections(pids) {
  try {
    const out = execSync('lsof -i -n -P 2>/dev/null', { encoding: 'utf8' });
    const conns = [];
    for (const line of out.split('\n')) {
      if (!line.includes('ESTABLISHED')) continue;
      const cols = line.trim().split(/\s+/);
      const pid = cols[1];
      if (!pids[pid]) continue;
      const conn = cols[8] || '';
      const match = conn.match(/->(.+):(\d+)$/);
      if (!match) continue;
      conns.push({ pid, label: pids[pid], ip: match[1], port: match[2] });
    }
    return conns;
  } catch { return []; }
}

function checkTlsCert(ip) {
  try {
    const out = execSync(
      `echo | openssl s_client -connect ${ip}:443 -servername api2.cursor.sh 2>/dev/null | openssl x509 -noout -subject 2>/dev/null`,
      { encoding: 'utf8', timeout: 5000 }
    );
    const m = out.match(/CN=(.+)/);
    return m ? m[1].trim() : 'unknown';
  } catch { return 'unreachable'; }
}

function analyzeExistingLogs() {
  if (!fs.existsSync(LOG_FILE)) return { total: 0, categories: {} };
  const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
  const categories = {};
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      const u = new URL(e.url);
      const host = u.hostname;
      const p = u.pathname;
      let cat = 'other';
      if (host === 'metrics.cursor.sh' || p.startsWith('/tev1/')) cat = 'telemetry';
      else if (p.includes('/auth/')) cat = 'auth';
      else if (p.includes('/updates/')) cat = 'update';
      else if (p.includes('/aiserver.v1.')) cat = 'ai';
      else if (host.includes('api5')) cat = 'agent-api5';
      categories[cat] = (categories[cat] || 0) + 1;
    } catch { }
  }
  return { total: lines.length, categories };
}

// ====== 主执行 ======

section('1. Cursor 进程分析');
const pids = getCursorPids();
const labelCounts = {};
for (const [pid, label] of Object.entries(pids)) {
  labelCounts[label] = labelCounts[label] || [];
  labelCounts[label].push(pid);
}
for (const [label, pidList] of Object.entries(labelCounts).sort()) {
  console.log(`  ${label}: PID ${pidList.join(', ')}`);
}

section('2. 网络连接分析');
const conns = getNetworkConnections(pids);
const ipToHostname = {};
const uniqueIps = [...new Set(conns.map(c => c.ip))];
console.log(`  发现 ${conns.length} 个活跃连接，${uniqueIps.length} 个不同 IP\n`);

for (const ip of uniqueIps) {
  ipToHostname[ip] = checkTlsCert(ip);
}

const byProcess = {};
for (const c of conns) {
  const key = `${c.label} (PID ${c.pid})`;
  byProcess[key] = byProcess[key] || [];
  byProcess[key].push(`${c.ip}:${c.port} → ${ipToHostname[c.ip] || '?'}`);
}
for (const [proc, targets] of Object.entries(byProcess).sort()) {
  console.log(`  ${proc}:`);
  for (const t of targets) console.log(`    ↳ ${t}`);
}

section('3. 已捕获日志分析');
const logAnalysis = analyzeExistingLogs();
console.log(`  总请求数: ${logAnalysis.total}`);
for (const [cat, count] of Object.entries(logAnalysis.categories).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${cat}: ${count}`);
}

section('4. 捕获覆盖率诊断');
const capturedProcesses = new Set();
capturedProcesses.add('chromium-network');
capturedProcesses.add('renderer');

const aiProcesses = ['ext-host-local', 'ext-host-agent', 'ext-host-retrieval'];
const aiConns = conns.filter(c => aiProcesses.includes(c.label));
const capturedConns = conns.filter(c => capturedProcesses.has(c.label));

console.log(`  webRequest 能捕获的进程: ${[...capturedProcesses].join(', ')}`);
console.log(`  webRequest 捕获的连接数: ${capturedConns.length}`);
console.log(`  AI 请求的进程: ${aiProcesses.join(', ')}`);
console.log(`  AI 进程的连接数: ${aiConns.length}`);
console.log('');

if (aiConns.length > 0) {
  console.log('  ⚠ AI 请求走的是 Extension Host 进程 (Node.js 原生 HTTP)');
  console.log('    这些请求绕过了 Chromium 网络栈，webRequest API 无法拦截！');
  console.log('');
  console.log('  AI 进程连接详情:');
  for (const c of aiConns) {
    console.log(`    ${c.label} → ${c.ip} (${ipToHostname[c.ip] || '?'})`);
  }
}

section('5. 结论与建议');
const hasAiGap = aiConns.length > 0 && (logAnalysis.categories['ai'] || 0) === 0;
if (hasAiGap) {
  console.log('  ❌ 确认存在捕获盲区:');
  console.log('');
  console.log('  当前架构:');
  console.log('    Cursor 渲染进程 (auth/telemetry) → Chromium 网络栈 → webRequest ✓ 已捕获');
  console.log('    Extension Host (AI 请求)         → Node.js http/https → ✗ 未捕获');
  console.log('');
  console.log('  Extension Host 进程使用 electron.utilityProcess.fork() 创建，');
  console.log('  运行在独立的 Node.js 环境中，使用原生 HTTP 客户端（fetch/undici）');
  console.log('  发送请求，完全绕过 Electron 的 Chromium 网络层。');
  console.log('');
  console.log('  可行的捕获方案:');
  console.log('  ┌─────────────────────────────────────────────────────────────┐');
  console.log('  │ 方案 A: 在 hook.mjs 中 monkey-patch utilityProcess.fork   │');
  console.log('  │         注入 NODE_OPTIONS 环境变量，加载预加载脚本          │');
  console.log('  │         预加载脚本 hook http/https/fetch 模块               │');
  console.log('  │         复杂度: ★★★  可靠性: ★★★★                         │');
  console.log('  ├─────────────────────────────────────────────────────────────┤');
  console.log('  │ 方案 B: 使用 Electron net 模块 + protocol 拦截            │');
  console.log('  │         从主进程级别拦截所有 sessions                       │');
  console.log('  │         复杂度: ★★  可靠性: ★★ (Extension Host 不走这里)   │');
  console.log('  ├─────────────────────────────────────────────────────────────┤');
  console.log('  │ 方案 C: 监听 Cursor 已有日志/IPC 通道                     │');
  console.log('  │         利用 Cursor 内部的 usage tracking                   │');
  console.log('  │         复杂度: ★  可靠性: ★ (依赖内部实现)               │');
  console.log('  └─────────────────────────────────────────────────────────────┘');
} else {
  console.log('  ✓ 未发现明显捕获盲区');
}
