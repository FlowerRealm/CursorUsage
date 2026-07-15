// cursor-usage-tracker preload-intercept.cjs
// Injected via utilityProcess.fork execArgv --require.
//
// Cursor AI (ConnectRPC) for Bidi often uses HTTP/1.1 (useHttp2:false) via https.request,
// consuming the body with async iterators — so we must NOT attach .on('data') listeners.
// We observe bytes via IncomingMessage.prototype.push and ClientRequest.write/end instead.
//
// Detail mode (detail-logging.on): capture ALL *.cursor.sh traffic with bodies+headers.
// Summary log (requests.jsonl): still AI-only (chat/agent/tab) for the dashboard.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const https = require('node:https');

const DATA_DIR = path.join(os.homedir(), '.cursor-usage-tracker');
const LOG_FILE = path.join(DATA_DIR, 'requests.jsonl');
const DETAIL_FILE = path.join(DATA_DIR, 'requests-detail.jsonl');
const DETAIL_FLAG = path.join(DATA_DIR, 'detail-logging.on');
const DEBUG_LOG = path.join(DATA_DIR, 'preload-debug.log');
const MAX_BODY_BYTES = Number(process.env.CURSOR_USAGE_MAX_BODY || 2 * 1024 * 1024);
const DETAIL_SCHEMA = 2;

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch {
  // ignore
}

function dbg(msg) {
  const line = `[${new Date().toISOString()}] pid=${process.pid} ${msg}\n`;
  try {
    fs.appendFileSync(DEBUG_LOG, line);
  } catch {
    // ignore
  }
  try {
    fs.appendFileSync(`/tmp/cut-preload-${process.pid}.log`, line);
  } catch {
    // ignore
  }
}

try {
  fs.writeFileSync(
    path.join(DATA_DIR, `preload-alive-${process.pid}`),
    `${new Date().toISOString()} ${process.title || ''}\n`,
    'utf8'
  );
} catch {
  // ignore
}
try {
  fs.writeFileSync(`/tmp/cut-alive-${process.pid}`, '1');
} catch {
  // ignore
}

function detailOn() {
  try {
    return fs.existsSync(DETAIL_FLAG);
  } catch {
    return false;
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

  // Usage / billing / dashboard (token, spend, quota)
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
    p.includes('getteam') ||
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

function getProcessLabel() {
  const title = process.title || '';
  const argv = process.argv.join(' ');
  const role = process.env.CURSOR_EXTENSION_HOST_ROLE || '';
  const vsTitle = process.env.VSCODE_PROCESS_TITLE || '';
  const blob = `${title} ${argv} ${role} ${vsTitle}`.toLowerCase();

  if (blob.includes('always-local')) return 'ext-host-local';
  if (blob.includes('agent-exec')) return 'ext-host-agent';
  if (blob.includes('retrieval')) return 'ext-host-retrieval';
  if (blob.includes('extensionhost') || blob.includes('extension-host')) return 'ext-host';
  if (blob.includes('shared-process')) return 'shared-process';
  if (vsTitle) return String(vsTitle).slice(0, 64);
  return `pid-${process.pid}`;
}

const PROC_LABEL = getProcessLabel();
let _seq = 0;
function nextId() {
  return `${Date.now()}-${process.pid}-${++_seq}`;
}

function appendJsonl(file, entry) {
  try {
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch {
    // ignore
  }
}

const REDACT_HEADER =
  /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|api-key|x-cursor-api-key)$/i;

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (REDACT_HEADER.test(k)) {
      out[k] = '[redacted]';
      continue;
    }
    if (Array.isArray(v)) out[k] = v.map((x) => String(x));
    else if (v == null) out[k] = '';
    else out[k] = String(v);
  }
  return out;
}

function headersFromFetchInit(init) {
  if (!init || !init.headers) return null;
  const h = init.headers;
  if (typeof Headers !== 'undefined' && h instanceof Headers) {
    const obj = {};
    h.forEach((v, k) => {
      obj[k] = v;
    });
    return sanitizeHeaders(obj);
  }
  if (Array.isArray(h)) {
    const obj = {};
    for (const pair of h) {
      if (pair && pair.length >= 2) obj[String(pair[0])] = String(pair[1]);
    }
    return sanitizeHeaders(obj);
  }
  return sanitizeHeaders(h);
}

function headersFromResponse(res) {
  if (!res || !res.headers) return null;
  if (typeof res.headers.get === 'function') {
    const obj = {};
    res.headers.forEach((v, k) => {
      obj[k] = v;
    });
    return sanitizeHeaders(obj);
  }
  return sanitizeHeaders(res.headers);
}

/** Always base64 — utf8 corrupts proto/gzip/SSE framing. */
function encodeBody(buf) {
  if (!buf || !buf.length) {
    return { body: '', bodyEncoding: 'base64', bodyBytes: 0, truncated: false };
  }
  let truncated = false;
  let slice = buf;
  if (buf.length > MAX_BODY_BYTES) {
    slice = buf.subarray(0, MAX_BODY_BYTES);
    truncated = true;
  }
  return {
    body: slice.toString('base64'),
    bodyEncoding: 'base64',
    bodyBytes: buf.length,
    truncated
  };
}

function streamKind(contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('text/event-stream')) return 'sse';
  if (ct.includes('proto') || ct.includes('grpc') || ct.includes('connect')) return 'proto';
  if (ct.includes('json')) return 'json';
  if (ct.includes('text/')) return 'text';
  return 'binary';
}

function parseCursorUrl(url) {
  if (typeof url !== 'string' || !url.includes('cursor.sh')) return null;
  try {
    const u = new URL(url);
    return { url: url.length > 800 ? url.slice(0, 800) : url, host: u.hostname, path: u.pathname };
  } catch {
    return null;
  }
}

/**
 * Classify any *.cursor.sh URL.
 * Summary log only wants AI; detail log wants everything when flag is on.
 */
function classifyUrl(urlStr) {
  const parsed = parseCursorUrl(urlStr);
  if (!parsed) return null;
  const category = categorize(parsed.host, parsed.path);
  return { ...parsed, category, isAi: isAiUsage(category) };
}

function shouldArm(classified) {
  if (!classified) return false;
  if (classified.isAi) return true;
  return detailOn();
}

function urlFromClientRequest(req) {
  try {
    const proto = req.protocol || (req.agent && req.agent.protocol) || 'https:';
    const host =
      req.host ||
      req.getHeader?.('host') ||
      (req.socket && (req.socket.servername || req.socket.remoteAddress)) ||
      '';
    const p = req.path || '/';
    if (!host) return '';
    return `${proto}//${host}${p}`;
  } catch {
    return '';
  }
}

function makeBucket() {
  return { chunks: [], kept: 0, total: 0, truncated: false };
}

function bucketPush(bucket, chunk, encoding) {
  if (chunk == null || bucket.truncated) return;
  const buf = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined);
  bucket.total += buf.length;
  const room = MAX_BODY_BYTES - bucket.kept;
  if (room <= 0) {
    bucket.truncated = true;
    return;
  }
  if (buf.length <= room) {
    bucket.chunks.push(buf);
    bucket.kept += buf.length;
  } else {
    bucket.chunks.push(buf.subarray(0, room));
    bucket.kept += room;
    bucket.truncated = true;
  }
}

function bucketBuf(bucket) {
  return Buffer.concat(bucket.chunks);
}

function bodyFromFetchInit(init) {
  if (!init || init.body == null) return Buffer.alloc(0);
  const b = init.body;
  if (Buffer.isBuffer(b)) return b;
  if (typeof b === 'string') return Buffer.from(b);
  if (b instanceof Uint8Array) return Buffer.from(b);
  if (typeof ArrayBuffer !== 'undefined' && b instanceof ArrayBuffer) return Buffer.from(b);
  // ReadableStream / FormData — skip (can't sync-read safely)
  return Buffer.alloc(0);
}

// ====== HTTP/1.1: prototype hooks (Connect uses https.request + asyncIterator) ======

if (!http.IncomingMessage.prototype.__cutPushPatched) {
  const origPush = http.IncomingMessage.prototype.push;
  http.IncomingMessage.prototype.push = function cutPush(chunk, encoding) {
    try {
      if (chunk && this.__cutOnPush) this.__cutOnPush(chunk);
    } catch {
      // ignore
    }
    return origPush.call(this, chunk, encoding);
  };
  http.IncomingMessage.prototype.__cutPushPatched = true;
}

if (!http.ClientRequest.prototype.__cutPatched) {
  const origWrite = http.ClientRequest.prototype.write;
  const origEnd = http.ClientRequest.prototype.end;
  const origEmit = http.ClientRequest.prototype.emit;

  http.ClientRequest.prototype.write = function cutWrite(chunk, encoding, cb) {
    try {
      if (this.__cutReqBucket && chunk != null && typeof chunk !== 'function') {
        bucketPush(this.__cutReqBucket, chunk, encoding);
      }
    } catch {
      // ignore
    }
    return origWrite.apply(this, arguments);
  };

  http.ClientRequest.prototype.end = function cutEnd(chunk, encoding, cb) {
    try {
      if (this.__cutReqBucket && chunk != null && typeof chunk !== 'function') {
        bucketPush(this.__cutReqBucket, chunk, encoding);
      }
    } catch {
      // ignore
    }
    return origEnd.apply(this, arguments);
  };

  http.ClientRequest.prototype.emit = function cutEmit(event) {
    if (event === 'socket' && !this.__cutArmed) {
      try {
        armClientRequest(this);
      } catch (e) {
        dbg(`arm fail: ${e && e.message ? e.message : e}`);
      }
    }
    if (event === 'response') {
      try {
        const res = arguments[1];
        onClientResponse(this, res);
      } catch (e) {
        dbg(`response hook fail: ${e && e.message ? e.message : e}`);
      }
    }
    return origEmit.apply(this, arguments);
  };

  http.ClientRequest.prototype.__cutPatched = true;
  dbg(`http.ClientRequest + IncomingMessage prototypes patched (${PROC_LABEL})`);
}

function armClientRequest(req) {
  if (req.__cutArmed) return;
  const urlStr = urlFromClientRequest(req);
  if (!urlStr.includes('cursor.sh')) {
    req.__cutArmed = 'skip';
    return;
  }
  const classified = classifyUrl(urlStr);
  if (!shouldArm(classified)) {
    req.__cutArmed = 'skip';
    return;
  }
  req.__cutArmed = true;
  req.__cutWantSummary = !!classified.isAi;
  req.__cutWantDetail = detailOn();
  let reqHeaders = null;
  try {
    reqHeaders = sanitizeHeaders(typeof req.getHeaders === 'function' ? req.getHeaders() : null);
  } catch {
    reqHeaders = null;
  }
  req.__cutMeta = {
    t: Date.now(),
    id: nextId(),
    url: classified.url,
    m: req.method || 'POST',
    category: classified.category,
    proc: PROC_LABEL,
    pid: process.pid,
    source: 'ext-host',
    transport: 'http1.1',
    reqHeaders
  };
  if (req.__cutWantDetail) {
    req.__cutReqBucket = makeBucket();
  }
}

function onClientResponse(req, res) {
  if (!req.__cutMeta || req.__cutArmed === 'skip') return;
  if (req.__cutResponseHooked) return;
  req.__cutResponseHooked = true;

  const meta = req.__cutMeta;
  const ct = (res.headers && res.headers['content-type']) || '';
  const ce = (res.headers && res.headers['content-encoding']) || '';
  meta.s = res.statusCode || 0;
  meta.contentType = Array.isArray(ct) ? ct[0] : ct || undefined;
  meta.contentEncoding = Array.isArray(ce) ? ce[0] : ce || undefined;
  meta.streamKind = streamKind(meta.contentType);
  meta.type = 'xhr';
  meta.resHeaders = headersFromResponse(res);

  const wantDetail = req.__cutWantDetail && detailOn();
  const resBucket = wantDetail ? makeBucket() : null;
  if (resBucket) {
    res.__cutOnPush = (chunk) => bucketPush(resBucket, chunk);
  }

  let finished = false;
  const finish = (extra) => {
    if (finished) return;
    finished = true;
    meta.duration = Date.now() - meta.t;
    const summary = {
      t: meta.t,
      id: meta.id,
      url: meta.url,
      m: meta.m,
      s: meta.s,
      type: meta.type,
      source: meta.source,
      transport: meta.transport,
      category: meta.category,
      proc: meta.proc,
      pid: meta.pid,
      contentType: meta.contentType,
      contentEncoding: meta.contentEncoding,
      streamKind: meta.streamKind,
      duration: meta.duration,
      ...extra
    };

    if (req.__cutWantSummary) {
      appendJsonl(LOG_FILE, summary);
    }

    if (wantDetail) {
      const reqEnc = encodeBody(req.__cutReqBucket ? bucketBuf(req.__cutReqBucket) : Buffer.alloc(0));
      const resEnc = encodeBody(resBucket ? bucketBuf(resBucket) : Buffer.alloc(0));
      appendJsonl(DETAIL_FILE, {
        ...summary,
        event: 'detail',
        v: DETAIL_SCHEMA,
        reqHeaders: meta.reqHeaders || null,
        resHeaders: meta.resHeaders || null,
        reqBody: reqEnc.body,
        reqBodyEncoding: reqEnc.bodyEncoding,
        reqBodyBytes: req.__cutReqBucket ? req.__cutReqBucket.total : 0,
        reqBodyTruncated: req.__cutReqBucket
          ? req.__cutReqBucket.truncated || reqEnc.truncated
          : false,
        resBody: resEnc.body,
        resBodyEncoding: resEnc.bodyEncoding,
        resBodyBytes: resBucket ? resBucket.total : 0,
        resBodyTruncated: resBucket ? resBucket.truncated || resEnc.truncated : false
      });
    }
  };

  // Prefer end; close covers aborted streams. setImmediate lets last push land.
  res.on('end', () => finish());
  res.on('close', () => setImmediate(() => finish()));
  res.on('error', (e) => finish({ error: e && e.message ? e.message : String(e) }));
}

function wrapRequestFn(mod, name) {
  if (!mod || typeof mod.request !== 'function' || mod.request.__cutWrapped) return;
  const orig = mod.request;
  mod.request = function cutRequest(...args) {
    const req = orig.apply(this, args);
    try {
      let urlHint = '';
      if (typeof args[0] === 'string') urlHint = args[0];
      else if (args[0] instanceof URL) urlHint = args[0].href;
      else if (args[0] && typeof args[0] === 'object' && args[0].href) urlHint = args[0].href;

      if (urlHint.includes('cursor.sh')) {
        const classified = classifyUrl(urlHint);
        if (shouldArm(classified)) {
          req.__cutArmed = true;
          req.__cutWantSummary = !!classified.isAi;
          req.__cutWantDetail = detailOn();
          let reqHeaders = null;
          try {
            const fromOpts =
              args[0] && typeof args[0] === 'object' && args[0].headers ? args[0].headers : null;
            reqHeaders =
              sanitizeHeaders(fromOpts) ||
              sanitizeHeaders(typeof req.getHeaders === 'function' ? req.getHeaders() : null);
          } catch {
            reqHeaders = null;
          }
          req.__cutMeta = {
            t: Date.now(),
            id: nextId(),
            url: classified.url,
            m: req.method || (args[0] && args[0].method) || 'POST',
            category: classified.category,
            proc: PROC_LABEL,
            pid: process.pid,
            source: 'ext-host',
            transport: 'http1.1',
            reqHeaders
          };
          if (req.__cutWantDetail) req.__cutReqBucket = makeBucket();
        } else {
          req.__cutArmed = 'skip';
        }
      }
    } catch {
      // ignore
    }
    return req;
  };
  mod.request.__cutWrapped = true;
  dbg(`${name}.request wrapped (${PROC_LABEL})`);
}

wrapRequestFn(http, 'http');
wrapRequestFn(https, 'https');

// fetch — usage dashboards and some agent paths
if (typeof globalThis.fetch === 'function' && !globalThis.fetch.__cutWrapped) {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async function cutFetch(input, init) {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input && input.url
            ? input.url
            : '';
    if (!url.includes('cursor.sh')) return origFetch.apply(this, arguments);
    const classified = classifyUrl(url);
    if (!shouldArm(classified)) return origFetch.apply(this, arguments);

    const start = Date.now();
    const id = nextId();
    const method = (init && init.method) || (input && input.method) || 'GET';
    const wantSummary = !!classified.isAi;
    const wantDetail = detailOn();
    const reqHeaders = headersFromFetchInit(init);
    const reqBuf = wantDetail ? bodyFromFetchInit(init) : Buffer.alloc(0);

    try {
      const res = await origFetch.apply(this, arguments);
      const ct = res.headers?.get?.('content-type') || '';
      const ce = res.headers?.get?.('content-encoding') || '';
      const summary = {
        t: start,
        id,
        url: classified.url,
        m: method,
        s: res.status,
        type: 'xhr',
        source: 'ext-host',
        transport: 'fetch',
        category: classified.category,
        proc: PROC_LABEL,
        pid: process.pid,
        contentType: ct || undefined,
        contentEncoding: ce || undefined,
        streamKind: streamKind(ct),
        duration: Date.now() - start
      };
      if (wantSummary) appendJsonl(LOG_FILE, summary);

      if (wantDetail) {
        const reqEnc = encodeBody(reqBuf);
        const resHeaders = headersFromResponse(res);
        try {
          const clone = res.clone();
          const reader = clone.body && clone.body.getReader && clone.body.getReader();
          const bucket = makeBucket();
          if (reader) {
            (async () => {
              try {
                for (; ;) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  if (value) bucketPush(bucket, value);
                  if (bucket.truncated) {
                    try {
                      await reader.cancel();
                    } catch {
                      // ignore
                    }
                    break;
                  }
                }
              } catch (e) {
                appendJsonl(DETAIL_FILE, {
                  ...summary,
                  event: 'detail',
                  v: DETAIL_SCHEMA,
                  reqHeaders,
                  resHeaders,
                  reqBody: reqEnc.body,
                  reqBodyEncoding: reqEnc.bodyEncoding,
                  reqBodyBytes: reqEnc.bodyBytes,
                  reqBodyTruncated: reqEnc.truncated,
                  resBodyError: e.message,
                  duration: Date.now() - start
                });
                return;
              }
              const enc = encodeBody(bucketBuf(bucket));
              appendJsonl(DETAIL_FILE, {
                ...summary,
                event: 'detail',
                v: DETAIL_SCHEMA,
                duration: Date.now() - start,
                reqHeaders,
                resHeaders,
                reqBody: reqEnc.body,
                reqBodyEncoding: reqEnc.bodyEncoding,
                reqBodyBytes: reqEnc.bodyBytes,
                reqBodyTruncated: reqEnc.truncated,
                resBody: enc.body,
                resBodyEncoding: enc.bodyEncoding,
                resBodyBytes: bucket.total,
                resBodyTruncated: bucket.truncated || enc.truncated
              });
            })();
          } else {
            appendJsonl(DETAIL_FILE, {
              ...summary,
              event: 'detail',
              v: DETAIL_SCHEMA,
              reqHeaders,
              resHeaders,
              reqBody: reqEnc.body,
              reqBodyEncoding: reqEnc.bodyEncoding,
              reqBodyBytes: reqEnc.bodyBytes,
              reqBodyTruncated: reqEnc.truncated,
              resBody: '',
              resBodyEncoding: 'base64',
              resBodyBytes: 0,
              resBodyTruncated: false
            });
          }
        } catch (e) {
          appendJsonl(DETAIL_FILE, {
            ...summary,
            event: 'detail',
            v: DETAIL_SCHEMA,
            reqHeaders,
            resBodyError: e.message
          });
        }
      }
      return res;
    } catch (err) {
      if (wantSummary) {
        appendJsonl(LOG_FILE, {
          t: start,
          id,
          url: classified.url,
          m: method,
          s: 0,
          source: 'ext-host',
          transport: 'fetch',
          category: classified.category,
          proc: PROC_LABEL,
          pid: process.pid,
          error: err.message,
          duration: Date.now() - start
        });
      }
      if (wantDetail) {
        const reqEnc = encodeBody(reqBuf);
        appendJsonl(DETAIL_FILE, {
          t: start,
          id,
          url: classified.url,
          m: method,
          s: 0,
          source: 'ext-host',
          transport: 'fetch',
          category: classified.category,
          proc: PROC_LABEL,
          pid: process.pid,
          event: 'detail',
          v: DETAIL_SCHEMA,
          reqHeaders,
          reqBody: reqEnc.body,
          reqBodyEncoding: reqEnc.bodyEncoding,
          reqBodyBytes: reqEnc.bodyBytes,
          error: err.message,
          duration: Date.now() - start
        });
      }
      throw err;
    }
  };
  globalThis.fetch.__cutWrapped = true;
  dbg(`fetch wrapped (${PROC_LABEL})`);
}

dbg(
  `preload ready (${PROC_LABEL}) detail=${detailOn()} maxBody=${MAX_BODY_BYTES} schema=v${DETAIL_SCHEMA} mode=full-when-detail`
);
