import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const CURSOR_APP = '/Applications/Cursor.app/Contents/Resources/app';
export const MAIN_JS = path.join(CURSOR_APP, 'out', 'main.js');
export const DATA_DIR = path.join(os.homedir(), '.cursor-usage-tracker');
export const BACKUP_FILE = path.join(DATA_DIR, 'main.js.bak');
export const VERSION_FILE = path.join(DATA_DIR, 'patched-version.txt');
export const LOG_FILE = path.join(DATA_DIR, 'requests.jsonl');
export const DETAIL_LOG_FILE = path.join(DATA_DIR, 'requests-detail.jsonl');
export const DETAIL_FLAG_FILE = path.join(DATA_DIR, 'detail-logging.on');
/** Per-request tokenUsage JSONL — separate from requests-detail.jsonl */
export const TOKENS_LOG_FILE = path.join(DATA_DIR, 'usage-tokens.jsonl');
export const DB_FILE = path.join(DATA_DIR, 'usage.db');
export const IMPORT_OFFSET_FILE = path.join(DATA_DIR, 'import-offset.txt');
export const HOOK_FILE = path.join(DATA_DIR, 'hook.mjs');
export const PRELOAD_FILE = path.join(DATA_DIR, 'preload-intercept.cjs');

/** Current loader marker — bump when HOOK_CODE (bootstrapper) changes */
export const HOOK_MARKER = '/* cursor-usage-tracker v0.3 */';
export const HOOK_MARKER_PREFIX = '/* cursor-usage-tracker';

/**
 * Thin hot-reload bootstrapper injected into Cursor main.js.
 * MUST remain exactly 2 lines (marker + one code line) for findHookRange.
 */
export const HOOK_CODE = `${HOOK_MARKER}
Promise.all([import('electron'),import('node:fs'),import('node:path'),import('node:os')]).then(([electron,fs,path,os])=>{const{app,session}=electron;app.whenReady().then(()=>{try{const hookPath=path.join(os.homedir(),'.cursor-usage-tracker','hook.mjs');if(!fs.existsSync(hookPath)){console.error('[cursor-usage-tracker] missing hook.mjs');return}const deps={session,fs,path,os};let ver=0,current=null,timer=null;const load=async()=>{try{if(current&&current.teardown)current.teardown(deps);const mod=await import('file://'+hookPath+'?v='+(++ver));if(mod.setup)mod.setup(deps);current=mod;console.log('[cursor-usage-tracker] hook loaded v'+ver)}catch(e){console.error('[cursor-usage-tracker] load error',e)}};load();fs.watch(hookPath,{persistent:false},(ev)=>{if(ev!=='change'&&ev!=='rename')return;clearTimeout(timer);timer=setTimeout(load,300)})}catch(e){console.error('[cursor-usage-tracker]',e)}})}).catch(e=>console.error('[cursor-usage-tracker]',e));
`;

export interface HookStatus {
  patched: boolean;
  hookVersion: string | null;
  needsUpgrade: boolean;
  cursorVersion: string;
  patchedVersion: string | null;
  versionMismatch: boolean;
  hasBackup: boolean;
  hasHookFile: boolean;
  hasPreloadFile: boolean;
  logExists: boolean;
  logCount: number;
  logSizeKb: number;
  detailLoggingEnabled: boolean;
  detailLogExists: boolean;
  detailLogCount: number;
  detailLogSizeKb: number;
  tokensLogExists: boolean;
  tokensLogCount: number;
  tokensLogSizeKb: number;
}

export function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function assetPath(name: string): string {
  return path.join(__dirname, name);
}

function readAssetOrThrow(name: string): string {
  const p = assetPath(name);
  if (!fs.existsSync(p)) {
    throw new Error(
      `Missing capture asset ${name} at ${p}. Run npm run build, or use: node patch-cursor.mjs sync-hook`
    );
  }
  return fs.readFileSync(p, 'utf8');
}

export function ensureHookFile(): void {
  ensureDataDir();
  fs.writeFileSync(HOOK_FILE, readAssetOrThrow('hook.mjs'));
  ensurePreloadFile();
}

export function ensurePreloadFile(): void {
  ensureDataDir();
  fs.writeFileSync(PRELOAD_FILE, readAssetOrThrow('preload-intercept.cjs'));
}

export function getCursorVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(CURSOR_APP, 'package.json'), 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function findHookRange(content: string): { start: number; end: number; marker: string } | null {
  const start = content.indexOf(HOOK_MARKER_PREFIX);
  if (start === -1) {
    return null;
  }
  const markerEnd = content.indexOf('*/', start);
  if (markerEnd === -1) {
    return null;
  }
  const marker = content.slice(start, markerEnd + 2);
  const firstNl = content.indexOf('\n', start);
  const secondNl = content.indexOf('\n', firstNl + 1);
  if (firstNl === -1 || secondNl === -1) {
    return null;
  }
  return { start, end: secondNl + 1, marker };
}

export function getInstalledHookVersion(): string | null {
  try {
    const content = fs.readFileSync(MAIN_JS, 'utf8');
    const range = findHookRange(content);
    if (!range) {
      return null;
    }
    const m = range.marker.match(/v([\d.]+)/);
    return m ? m[1] : 'unknown';
  } catch {
    return null;
  }
}

export function isPatched(): boolean {
  return getInstalledHookVersion() !== null;
}

export function isCurrentHookInstalled(): boolean {
  try {
    const content = fs.readFileSync(MAIN_JS, 'utf8');
    return content.includes(HOOK_MARKER);
  } catch {
    return false;
  }
}

export function isDetailLoggingEnabled(): boolean {
  return fs.existsSync(DETAIL_FLAG_FILE);
}

export function enableDetailLogging(): { ok: boolean; message: string } {
  ensureDataDir();
  fs.writeFileSync(DETAIL_FLAG_FILE, '1\n');
  return {
    ok: true,
    message:
      `Detail logging ENABLED.\n` +
      `New request details will append to:\n${DETAIL_LOG_FILE}\n` +
      `(Existing detail file is kept. No Cursor restart needed.)`
  };
}

export function disableDetailLogging(): { ok: boolean; message: string } {
  if (fs.existsSync(DETAIL_FLAG_FILE)) {
    fs.unlinkSync(DETAIL_FLAG_FILE);
  }
  return {
    ok: true,
    message:
      `Detail logging DISABLED.\n` +
      `Detail file was NOT deleted:\n${DETAIL_LOG_FILE}\n` +
      `Re-enable later to continue appending.`
  };
}

function countJsonlLines(filePath: string): { count: number; sizeKb: number; exists: boolean } {
  if (!fs.existsSync(filePath)) {
    return { count: 0, sizeKb: 0, exists: false };
  }
  const stats = fs.statSync(filePath);
  const content = fs.readFileSync(filePath, 'utf8').trim();
  const count = content ? content.split('\n').filter(Boolean).length : 0;
  return { count, sizeKb: stats.size / 1024, exists: true };
}

export function getStatus(): HookStatus {
  const hookVersion = getInstalledHookVersion();
  const patched = hookVersion !== null;
  const cursorVersion = getCursorVersion();
  const hasBackup = fs.existsSync(BACKUP_FILE);
  const patchedVersion = fs.existsSync(VERSION_FILE)
    ? fs.readFileSync(VERSION_FILE, 'utf8').trim()
    : null;
  const log = countJsonlLines(LOG_FILE);
  const detail = countJsonlLines(DETAIL_LOG_FILE);
  const tokens = countJsonlLines(TOKENS_LOG_FILE);

  return {
    patched,
    hookVersion,
    needsUpgrade: patched && !isCurrentHookInstalled(),
    cursorVersion,
    patchedVersion,
    versionMismatch: !!patchedVersion && patchedVersion !== cursorVersion,
    hasBackup,
    hasHookFile: fs.existsSync(HOOK_FILE),
    hasPreloadFile: fs.existsSync(PRELOAD_FILE),
    logExists: log.exists,
    logCount: log.count,
    logSizeKb: log.sizeKb,
    detailLoggingEnabled: isDetailLoggingEnabled(),
    detailLogExists: detail.exists,
    detailLogCount: detail.count,
    detailLogSizeKb: detail.sizeKb,
    tokensLogExists: tokens.exists,
    tokensLogCount: tokens.count,
    tokensLogSizeKb: tokens.sizeKb
  };
}

export function formatStatus(status: HookStatus): string {
  const lines = [
    `Cursor version:  ${status.cursorVersion}`,
    `Hook status:     ${status.patched ? `Installed (v${status.hookVersion})` : 'Not installed'}`,
    `External hook:   ${status.hasHookFile ? HOOK_FILE : 'Missing (run Install Hook)'}`,
    `Preload script:  ${status.hasPreloadFile ? PRELOAD_FILE : 'Missing (run Install Hook)'}`,
    `Capture path:    utilityProcess.fork execArgv --require (primary only)`,
    `Filter:          chat / agent / tab only`,
    `Backup:          ${status.hasBackup ? 'Yes' : 'No'}`,
    `Detail logging:  ${status.detailLoggingEnabled ? 'ON' : 'OFF (default)'}`
  ];
  if (status.needsUpgrade) {
    lines.push('WARNING: Hook loader is outdated. Please reinstall/upgrade the hook.');
  }
  if (status.patchedVersion) {
    lines.push(`Patched version: ${status.patchedVersion}`);
    if (status.versionMismatch) {
      lines.push('WARNING: Cursor was updated. Please reinstall the hook.');
    }
  }
  if (status.logExists) {
    lines.push(
      `Usage log:       ${status.logCount} records (${status.logSizeKb.toFixed(1)} KB)`
    );
  } else {
    lines.push('Usage log:       Not created yet (restart Cursor after installing)');
  }
  if (status.detailLogExists) {
    lines.push(
      `Detail log:      ${status.detailLogCount} records (${status.detailLogSizeKb.toFixed(1)} KB)`
    );
  } else {
    lines.push('Detail log:      Empty / not created yet');
  }
  if (status.tokensLogExists) {
    lines.push(
      `Tokens log:      ${status.tokensLogCount} records (${status.tokensLogSizeKb.toFixed(1)} KB)`
    );
  } else {
    lines.push('Tokens log:      Empty / not created yet (sync billing to populate)');
  }
  if (status.hookVersion === '0.3' || (status.hookVersion && Number(status.hookVersion) >= 0.3)) {
    lines.push('Hot-reload:      Edit hook.mjs to update capture logic without restarting Cursor.');
    lines.push('AI capture:      Requires Cursor restart so Extension Host loads preload.');
  }
  return lines.join('\n');
}

function insertOrReplaceHook(original: string): string {
  const range = findHookRange(original);
  if (range) {
    return original.slice(0, range.start) + HOOK_CODE + '\n' + original.slice(range.end);
  }
  const commentEnd = original.indexOf('*/');
  if (commentEnd === -1) {
    throw new Error('Cannot find copyright comment end in main.js.');
  }
  const insertPos = commentEnd + 2;
  return original.slice(0, insertPos) + '\n' + HOOK_CODE + original.slice(insertPos);
}

export function patch(): { ok: boolean; message: string } {
  try {
    ensureHookFile();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: msg };
  }

  if (isCurrentHookInstalled()) {
    return {
      ok: true,
      message:
        `Hook loader is already installed (v0.3).\n` +
        `Synced:\n  ${HOOK_FILE}\n  ${PRELOAD_FILE}\n` +
        `Capture: fork execArgv --require (AI: chat/agent/tab only).\n` +
        `Restart Cursor once so Extension Host processes load preload.`
    };
  }

  if (!fs.existsSync(MAIN_JS)) {
    return { ok: false, message: `Cannot find Cursor main.js at ${MAIN_JS}` };
  }

  const version = getCursorVersion();
  ensureDataDir();

  const hadOldHook = isPatched();
  if (!hadOldHook) {
    fs.copyFileSync(MAIN_JS, BACKUP_FILE);
  }

  fs.writeFileSync(VERSION_FILE, version);

  try {
    const original = fs.readFileSync(MAIN_JS, 'utf8');
    const patched = insertOrReplaceHook(original);
    fs.writeFileSync(MAIN_JS, patched);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: msg };
  }

  const action = hadOldHook ? 'upgraded' : 'installed';
  return {
    ok: true,
    message:
      `Hook ${action} for Cursor ${version} (v0.3 hot-reload loader).\n` +
      `Loader:    main.js (thin bootstrapper)\n` +
      `Logic:     ${HOOK_FILE}\n` +
      `Preload:   ${PRELOAD_FILE} (via fork execArgv)\n` +
      `Filter:    chat / agent / tab only\n` +
      `Usage log: ${LOG_FILE}\n` +
      'Please restart Cursor ONCE to activate the loader and Extension Host preload.'
  };
}

export function unpatch(): { ok: boolean; message: string } {
  if (!isPatched()) {
    return { ok: true, message: 'Hook is not installed. Nothing to do.' };
  }

  if (fs.existsSync(BACKUP_FILE)) {
    fs.copyFileSync(BACKUP_FILE, MAIN_JS);
  } else {
    const content = fs.readFileSync(MAIN_JS, 'utf8');
    const range = findHookRange(content);
    if (!range) {
      return { ok: false, message: 'Cannot locate hook marker to remove.' };
    }
    const restored = content.slice(0, range.start) + content.slice(range.end);
    fs.writeFileSync(MAIN_JS, restored);
  }

  return {
    ok: true,
    message: 'Hook uninstalled from main.js. Please restart Cursor for the change to take effect.'
  };
}
