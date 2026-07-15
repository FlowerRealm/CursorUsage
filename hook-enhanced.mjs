// hook-enhanced.mjs — 增强版流量捕获（测试版）
// 在原有 webRequest 基础上，测试多种拦截方式以捕获 Extension Host 中的 AI 请求

let _session = null;
let _patchApplied = false;
let _origHttpsRequest = null;

/**
 * @param {{ session: import('electron').Session, fs: typeof import('node:fs'), path: typeof import('node:path'), os: typeof import('node:os') }} deps
 */
export async function setup({ session, fs, path, os }) {
  _session = session;
  const dir = path.join(os.homedir(), '.cursor-usage-tracker');
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, 'requests.jsonl');
  const detailFile = path.join(dir, 'requests-detail.jsonl');
  const detailFlag = path.join(dir, 'detail-logging.on');
  const debugLog = path.join(dir, 'hook-debug.log');
  const filter = { urls: ['*://*.cursor.sh/*'] };

  const dbg = (msg) => {
    fs.appendFile(debugLog, `[${new Date().toISOString()}] ${msg}\n`, () => { });
  };

  const detailOn = () => {
    try { return fs.existsSync(detailFlag); } catch { return false; }
  };

  // ====== 原有 webRequest 捕获（保持不变）======
  session.defaultSession.webRequest.onCompleted(filter, (d) => {
    const entry = { t: Date.now(), url: d.url, m: d.method, s: d.statusCode, type: d.resourceType };
    fs.appendFile(logFile, JSON.stringify(entry) + '\n', () => { });
    if (detailOn()) {
      const detail = {
        t: entry.t, url: d.url, m: d.method, s: d.statusCode, type: d.resourceType,
        id: d.id, ip: d.ip || null, fromCache: !!d.fromCache, referrer: d.referrer || null,
        statusLine: d.statusLine || null, resHeaders: d.responseHeaders || null
      };
      fs.appendFile(detailFile, JSON.stringify(detail) + '\n', () => { });
    }
  });

  session.defaultSession.webRequest.onErrorOccurred(filter, (d) => {
    if (!detailOn()) return;
    const detail = {
      t: Date.now(), url: d.url, m: d.method, s: 0, type: d.resourceType,
      id: d.id, error: d.error || true
    };
    fs.appendFile(detailFile, JSON.stringify(detail) + '\n', () => { });
  });

  // ====== 增强 1: onResponseStarted（流式响应开始时就触发）======
  session.defaultSession.webRequest.onResponseStarted(filter, (d) => {
    const entry = {
      t: Date.now(), url: d.url, m: d.method, s: d.statusCode, type: d.resourceType,
      event: 'responseStarted',
      contentType: d.responseHeaders?.['content-type']?.[0] || ''
    };
    fs.appendFile(
      path.join(dir, 'webRequest-enhanced.jsonl'),
      JSON.stringify(entry) + '\n', () => { }
    );
  });
  dbg('webRequest.onResponseStarted registered');

  // ====== 增强 2: 动态 import electron，尝试遍历所有 session ======
  try {
    const electron = await import('electron');
    const { webContents } = electron;
    if (webContents && typeof webContents.getAllWebContents === 'function') {
      const allContents = webContents.getAllWebContents();
      const sessionsChecked = new Set();
      let otherSessionCount = 0;
      for (const wc of allContents) {
        const sess = wc.session;
        if (sess === session.defaultSession) continue;
        const partKey = wc.id + '';
        if (sessionsChecked.has(partKey)) continue;
        sessionsChecked.add(partKey);
        try {
          sess.webRequest.onResponseStarted(filter, (d) => {
            fs.appendFile(
              path.join(dir, 'sessions-enhanced.jsonl'),
              JSON.stringify({
                t: Date.now(), url: d.url, m: d.method, s: d.statusCode,
                wcId: wc.id, event: 'otherSession-responseStarted'
              }) + '\n', () => { }
            );
          });
          otherSessionCount++;
        } catch { }
      }
      dbg(`Checked ${allContents.length} webContents, hooked ${otherSessionCount} other sessions`);
    }
  } catch (e) {
    dbg(`getAllWebContents error: ${e.message}`);
  }

  // ====== 增强 3: Monkey-patch utilityProcess.fork() ======
  if (!_patchApplied) {
    try {
      const electron = await import('electron');
      const preloadScript = path.join(dir, 'preload-intercept.cjs');

      // 从项目目录复制预加载脚本
      const projectPreload = path.join(os.homedir(), 'CursorUsage', 'scripts', 'preload-intercept.cjs');
      if (fs.existsSync(projectPreload)) {
        fs.copyFileSync(projectPreload, preloadScript);
        dbg(`Copied preload script from ${projectPreload}`);
      } else if (!fs.existsSync(preloadScript)) {
        // 内联精简版
        fs.writeFileSync(preloadScript, `
const fs=require('fs'),path=require('path'),os=require('os');
const LOG=path.join(os.homedir(),'.cursor-usage-tracker','requests-ext.jsonl');
function log(e){try{fs.appendFileSync(LOG,JSON.stringify(e)+'\\n')}catch{}}
const label=(process.title||'pid-'+process.pid).replace(/[^a-zA-Z0-9_()-]/g,'_');
if(typeof globalThis.fetch==='function'){
  const orig=globalThis.fetch;
  globalThis.fetch=async function(input,init){
    const url=typeof input==='string'?input:(input instanceof URL?input.href:input?.url||'');
    if(url.includes('cursor.sh')){const t=Date.now();
      try{const r=await orig.call(this,input,init);
        log({t,source:'fetch',proc:label,pid:process.pid,url:url.slice(0,500),m:init?.method||'GET',s:r.status,ct:r.headers.get('content-type')||'',dur:Date.now()-t});return r
      }catch(e){log({t,source:'fetch',proc:label,pid:process.pid,url,m:init?.method||'GET',s:0,error:e.message});throw e}}
    return orig.call(this,input,init)};
}
try{const https=require('https'),origR=https.request;
  https.request=function(...a){const req=origR.apply(this,a);
    const opts=typeof a[0]==='string'?new URL(a[0]):a[0];
    const h=opts?.hostname||opts?.host||'';
    if(h.includes('cursor.sh')){req.on('response',res=>{
      log({t:Date.now(),source:'https',proc:label,pid:process.pid,url:'https://'+h+(opts?.path||'/'),m:req.method,s:res.statusCode,ct:res.headers['content-type']||''})});}
    return req}}catch{}
`);
        dbg('Created inline preload script');
      }

      if (electron.utilityProcess && typeof electron.utilityProcess.fork === 'function') {
        const origFork = electron.utilityProcess.fork;
        electron.utilityProcess.fork = function patchedFork(modulePath, args, options) {
          options = options || {};
          options.env = options.env || { ...process.env };
          const existingNodeOptions = options.env.NODE_OPTIONS || '';
          if (!existingNodeOptions.includes('preload-intercept')) {
            options.env.NODE_OPTIONS = `--require="${preloadScript}" ${existingNodeOptions}`.trim();
          }
          dbg(`Patched fork: ${options.serviceName || 'unknown'} with preload`);
          return origFork.call(this, modulePath, args, options);
        };
        _patchApplied = true;
        dbg('utilityProcess.fork patched successfully');
      } else {
        dbg('utilityProcess.fork not available on electron module');
        dbg(`electron keys: ${Object.keys(electron).join(', ')}`);
      }
    } catch (e) {
      dbg(`fork patch error: ${e.message}\n${e.stack}`);
    }
  }

  // ====== 增强 4: Main process http/https/fetch monkey-patch ======
  try {
    const https = await import('node:https');
    if (https.request && !_origHttpsRequest) {
      _origHttpsRequest = https.request;
      const origReq = https.request;
      // Note: ESM imports are live bindings but we can't reassign them
      // Try to patch the default export object instead
      const httpsModule = await import('node:https');
      if (httpsModule.default && httpsModule.default.request) {
        const origDefReq = httpsModule.default.request;
        httpsModule.default.request = function (...args) {
          const req = origDefReq.apply(this, args);
          const opts = typeof args[0] === 'string' ? new URL(args[0]) : args[0];
          const hostname = opts?.hostname || opts?.host || '';
          if (hostname.includes('cursor.sh')) {
            req.on('response', (res) => {
              fs.appendFile(
                path.join(dir, 'main-process-http.jsonl'),
                JSON.stringify({
                  t: Date.now(), url: `https://${hostname}${opts?.path || '/'}`,
                  m: req.method, s: res.statusCode, source: 'main-https',
                  contentType: res.headers['content-type'] || ''
                }) + '\n', () => { }
              );
            });
          }
          return req;
        };
        dbg('Main process https.default.request patched');
      }
    }
  } catch (e) {
    dbg(`Main https patch error: ${e.message}`);
  }

  // ====== 增强 5: 尝试从 app 上获取进程信息 ======
  try {
    const electron = await import('electron');
    const metrics = electron.app.getAppMetrics();
    const metricsInfo = metrics.map(m => `${m.pid}:${m.type}${m.serviceName ? '(' + m.serviceName + ')' : ''}`);
    dbg(`App metrics (${metrics.length} processes): ${metricsInfo.join(', ')}`);
  } catch (e) {
    dbg(`App metrics error: ${e.message}`);
  }

  dbg('Enhanced hook setup complete');
}

export function teardown(deps) {
  const session = deps?.session || _session;
  if (!session) return;
  try {
    session.defaultSession.webRequest.onCompleted(null);
    session.defaultSession.webRequest.onErrorOccurred(null);
    session.defaultSession.webRequest.onResponseStarted(null);
  } catch { }
  _session = null;
}
