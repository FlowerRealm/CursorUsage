// cursor-usage-tracker hook.mjs — external hot-reloadable traffic capture
// Loaded by the thin bootstrapper patched into Cursor main.js.
//
// Primary path only: monkey-patch utilityProcess.fork → execArgv --require preload.
// Summary log: only chat / agent / tab (AI usage).
// Detail log (when flag on): ALL *.cursor.sh (bodies come from preload).

let _session = null;
let _forkPatched = false;
let _origFork = null;
let _debugFs = null;
let _debugPath = null;

function dbg(msg) {
  if (!_debugFs || !_debugPath) return;
  try {
    _debugFs.appendFileSync(_debugPath, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    // ignore
  }
}

/** Keep in sync with src/storage/classifier.ts */
function categorize(host, urlPath) {
  const h = String(host || '').toLowerCase();
  const p = String(urlPath || '').toLowerCase();

  if (h === 'metrics.cursor.sh' || p.startsWith('/tev1/')) return 'telemetry';
  if (p.includes('/auth/') || h.includes('authentication.cursor.sh') || h === 'authenticator.cursor.sh') {
    return 'auth';
  }
  if (p.includes('/updates/')) return 'update';
  if (h === 'repo42.cursor.sh') return 'indexing';
  if (
    p.includes('usage') ||
    p.includes('dashboard') ||
    p.includes('billing') ||
    p.includes('payment') ||
    p.includes('stripe') ||
    p.includes('invoice') ||
    p.includes('spend') ||
    p.includes('quota') ||
    p.includes('credit') ||
    p.includes('ratelimit') ||
    p.includes('rate_limit') ||
    p.includes('hardlimit') ||
    p.includes('monthlyinvoice')
  ) {
    return 'usage';
  }
  if (h.endsWith('.api5.cursor.sh') || h === 'api5.cursor.sh') return 'agent';

  if (h === 'api2.cursor.sh' || h.endsWith('.api2.cursor.sh')) {
    if (p.includes('tabservice') || p.includes('cppservice') || p.includes('/cpp') || p.includes('complete')) {
      return 'tab';
    }
    if (p.includes('agentservice') || p.includes('backgroundcomposerservice')) return 'agent';
    if (
      p.includes('bidiservice') ||
      p.includes('chatservice') ||
      p.includes('conversationservice') ||
      p.includes('aiserver.v1.aiservice/stream') ||
      p.includes('aiserver.v1.aiservice/chat') ||
      p.includes('aiserver.v1.aiservice/run') ||
      p.includes('aiserver.v1.aiservice/agent')
    ) {
      return 'chat';
    }
    return 'other';
  }

  if ((h === 'api3.cursor.sh' || h === 'api4.cursor.sh') && !p.startsWith('/tev1/')) {
    if (p.includes('aiserver') || p.includes('cpp') || p.includes('tab') || p.includes('complete')) {
      return 'tab';
    }
  }
  return 'other';
}

function isAiUsage(category) {
  return category === 'chat' || category === 'agent' || category === 'tab';
}

function categoryForUrl(url) {
  try {
    const u = new URL(url);
    return categorize(u.hostname, u.pathname);
  } catch {
    return 'other';
  }
}

/**
 * @param {{ session: import('electron').Session, fs: typeof import('node:fs'), path: typeof import('node:path'), os: typeof import('node:os') }} deps
 */
export async function setup({ session, fs, path, os }) {
  _session = session;
  const dir = path.join(os.homedir(), '.cursor-usage-tracker');
  fs.mkdirSync(dir, { recursive: true });
  _debugFs = fs;
  _debugPath = path.join(dir, 'hook-debug.log');

  const logFile = path.join(dir, 'requests.jsonl');
  const detailFile = path.join(dir, 'requests-detail.jsonl');
  const detailFlag = path.join(dir, 'detail-logging.on');
  const preloadPath = path.join(dir, 'preload-intercept.cjs');
  const filter = { urls: ['*://*.cursor.sh/*'] };

  const detailOn = () => {
    try {
      return fs.existsSync(detailFlag);
    } catch {
      return false;
    }
  };

  // ====== Chromium webRequest ======
  // Summary: AI-only. Detail: all *.cursor.sh (metadata/headers; bodies via preload).
  session.defaultSession.webRequest.onCompleted(filter, (d) => {
    const category = categoryForUrl(d.url);
    const ai = isAiUsage(category);
    const entry = {
      t: Date.now(),
      url: d.url,
      m: d.method,
      s: d.statusCode,
      type: d.resourceType,
      source: 'webRequest',
      category
    };
    if (ai) {
      fs.appendFile(logFile, JSON.stringify(entry) + '\n', () => { });
    }
    if (detailOn()) {
      fs.appendFile(
        detailFile,
        JSON.stringify({
          ...entry,
          event: 'detail',
          v: 2,
          id: d.id,
          ip: d.ip || null,
          fromCache: !!d.fromCache,
          referrer: d.referrer || null,
          statusLine: d.statusLine || null,
          resHeaders: d.responseHeaders || null
        }) + '\n',
        () => { }
      );
    }
  });

  session.defaultSession.webRequest.onErrorOccurred(filter, (d) => {
    if (!detailOn()) return;
    const category = categoryForUrl(d.url);
    fs.appendFile(
      detailFile,
      JSON.stringify({
        t: Date.now(),
        url: d.url,
        m: d.method,
        s: 0,
        type: d.resourceType,
        source: 'webRequest',
        category,
        event: 'detail',
        v: 2,
        id: d.id,
        error: d.error || true
      }) + '\n',
      () => { }
    );
  });

  // ====== Primary path: inject preload via utilityProcess.fork execArgv ======
  if (!_forkPatched) {
    try {
      if (!fs.existsSync(preloadPath)) {
        dbg(`preload missing at ${preloadPath} — skip fork patch`);
      } else {
        const electron = await import('electron');
        // Ensure children that inherit env also load preload (Electron may strip this)
        const requireFlag = `--require=${preloadPath}`;
        try {
          const cur = process.env.NODE_OPTIONS || '';
          if (!cur.includes('preload-intercept')) {
            process.env.NODE_OPTIONS = `${requireFlag} ${cur}`.trim();
            dbg(`set process.env.NODE_OPTIONS for child inheritance`);
          }
        } catch {
          // ignore
        }

        if (electron.utilityProcess && typeof electron.utilityProcess.fork === 'function') {
          _origFork = electron.utilityProcess.fork;
          electron.utilityProcess.fork = function patchedFork(modulePath, args, options) {
            options = options ? { ...options } : {};
            const execArgv = Array.isArray(options.execArgv) ? [...options.execArgv] : [];
            // Prefer two-token form: Electron/Node both accept `--require <path>`
            const hasRequire = execArgv.some(
              (a, i) =>
                (typeof a === 'string' && a.includes('preload-intercept')) ||
                (a === '--require' && String(execArgv[i + 1] || '').includes('preload-intercept'))
            );
            if (!hasRequire) {
              execArgv.push('--require', preloadPath);
            }
            options.execArgv = execArgv;
            options.env = { ...(options.env || process.env) };
            const existing = options.env.NODE_OPTIONS || '';
            if (!existing.includes('preload-intercept')) {
              options.env.NODE_OPTIONS = `${requireFlag} ${existing}`.trim();
            }
            // Some Electron builds only honor ELECTRON_RUN_AS_NODE + NODE_OPTIONS
            dbg(
              `fork inject: service=${options.serviceName || modulePath} execArgv=${JSON.stringify(execArgv)} nodeOptions=${options.env.NODE_OPTIONS}`
            );
            return _origFork.call(this, modulePath, args, options);
          };
          _forkPatched = true;
          dbg(`utilityProcess.fork patched; preload=${preloadPath}`);
        } else {
          dbg('utilityProcess.fork unavailable');
        }
      }
    } catch (e) {
      dbg(`fork patch error: ${e && e.message ? e.message : e}`);
    }
  }

  dbg('hook setup complete (summary=AI, detail=all-cursor.sh, bodies via preload)');
}

/**
 * @param {{ session?: import('electron').Session }} [deps]
 */
export function teardown(deps) {
  const session = deps?.session || _session;
  if (!session) return;
  try {
    session.defaultSession.webRequest.onCompleted(null);
    session.defaultSession.webRequest.onErrorOccurred(null);
  } catch {
    // ignore
  }
  _session = null;
}
