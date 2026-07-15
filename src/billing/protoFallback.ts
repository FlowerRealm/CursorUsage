import * as fs from 'fs';
import { DETAIL_LOG_FILE } from '../patcher';
import { PeriodUsageResponse } from './cursorApi';

function readVarint(buf: Buffer, i: number): [number, number] {
  let x = 0;
  let s = 0;
  while (i < buf.length) {
    const b = buf[i++];
    // Avoid JS 32-bit bitwise truncation for timestamps > 2^31
    x += (b & 0x7f) * 2 ** s;
    if (!(b & 0x80)) {
      break;
    }
    s += 7;
    if (s > 53) {
      break;
    }
  }
  return [x, i];
}

interface ProtoField {
  field: number;
  wt: number;
  value: number | Buffer;
}

function decodeProto(buf: Buffer, maxFields = 80): ProtoField[] {
  const out: ProtoField[] = [];
  let i = 0;
  while (i < buf.length && out.length < maxFields) {
    const [key, ni] = readVarint(buf, i);
    i = ni;
    const field = key >>> 3;
    const wt = key & 7;
    if (wt === 0) {
      const [val, nj] = readVarint(buf, i);
      i = nj;
      out.push({ field, wt, value: val });
    } else if (wt === 2) {
      const [ln, nj] = readVarint(buf, i);
      i = nj;
      if (i + ln > buf.length) {
        break;
      }
      out.push({ field, wt, value: buf.subarray(i, i + ln) });
      i += ln;
    } else if (wt === 1) {
      i += 8;
    } else if (wt === 5) {
      i += 4;
    } else {
      break;
    }
  }
  return out;
}

function asString(v: number | Buffer): string | undefined {
  if (!Buffer.isBuffer(v)) {
    return undefined;
  }
  try {
    const s = v.toString('utf8');
    if ([...s].every((c) => c === '\n' || c === '\t' || c === '\r' || (c >= ' ' && c <= '~') || c.charCodeAt(0) > 127)) {
      return s;
    }
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Best-effort parse of captured GetCurrentPeriodUsage application/proto body.
 * Field numbers inferred from live captures; may drift if Cursor changes schema.
 */
export function parsePeriodUsageProto(buf: Buffer): PeriodUsageResponse | null {
  const top = decodeProto(buf);
  if (top.length === 0) {
    return null;
  }

  let cycleStart = 0;
  let cycleEnd = 0;
  let displayMessage = '';
  let planMsg = '';
  let apiMsg = '';
  let planBucket: ProtoField[] = [];

  for (const f of top) {
    if (f.field === 1 && f.wt === 0) {
      cycleStart = f.value as number;
    } else if (f.field === 2 && f.wt === 0) {
      cycleEnd = f.value as number;
    } else if (f.field === 3 && Buffer.isBuffer(f.value)) {
      planBucket = decodeProto(f.value);
    } else if (f.field === 7 && Buffer.isBuffer(f.value)) {
      displayMessage = asString(f.value) || displayMessage;
    } else if (f.field === 11 && Buffer.isBuffer(f.value)) {
      planMsg = asString(f.value) || planMsg;
    } else if (f.field === 12 && Buffer.isBuffer(f.value)) {
      apiMsg = asString(f.value) || apiMsg;
    }
  }

  let totalSpend = 0;
  let includedSpend = 0;
  let bonusSpend = 0;
  let limit = 0;
  let bonusTooltip = '';

  for (const f of planBucket) {
    if (f.field === 1 && f.wt === 0) {
      totalSpend = f.value as number;
    } else if (f.field === 2 && f.wt === 0) {
      includedSpend = f.value as number;
    } else if (f.field === 3 && f.wt === 0) {
      bonusSpend = f.value as number;
    } else if (f.field === 5 && f.wt === 0) {
      limit = f.value as number;
    } else if (f.field === 7 && Buffer.isBuffer(f.value)) {
      bonusTooltip = asString(f.value) || '';
    }
  }

  if (!cycleStart && !totalSpend && !limit) {
    return null;
  }

  return {
    billingCycleStart: String(cycleStart || ''),
    billingCycleEnd: String(cycleEnd || ''),
    planUsage: {
      totalSpend,
      includedSpend: includedSpend || limit,
      bonusSpend,
      limit: limit || includedSpend,
      bonusTooltip: bonusTooltip || undefined
    },
    enabled: true,
    displayMessage: displayMessage || undefined,
    autoModelSelectedDisplayMessage: planMsg || undefined,
    namedModelSelectedDisplayMessage: apiMsg || undefined
  };
}

export function loadPeriodUsageFromDetailLog(): PeriodUsageResponse | null {
  if (!fs.existsSync(DETAIL_LOG_FILE)) {
    return null;
  }
  // Read last ~2MB to avoid huge files
  const st = fs.statSync(DETAIL_LOG_FILE);
  const max = 2 * 1024 * 1024;
  const fd = fs.openSync(DETAIL_LOG_FILE, 'r');
  try {
    const start = Math.max(0, st.size - max);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line || !line.includes('GetCurrentPeriodUsage')) {
        continue;
      }
      try {
        const entry = JSON.parse(line) as {
          url?: string;
          resBody?: string;
          resBodyEncoding?: string;
          resBodyBytes?: number;
        };
        if (!entry.url?.includes('GetCurrentPeriodUsage') || !entry.resBody || !entry.resBodyBytes) {
          continue;
        }
        const raw =
          entry.resBodyEncoding === 'base64'
            ? Buffer.from(entry.resBody, 'base64')
            : Buffer.from(entry.resBody, 'utf8');
        // gunzip if needed
        let body = raw;
        if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const zlib = require('node:zlib') as typeof import('node:zlib');
          body = zlib.gunzipSync(raw);
        }
        const parsed = parsePeriodUsageProto(body);
        if (parsed) {
          return parsed;
        }
      } catch {
        // continue
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return null;
}

export interface PlanInfoFallback {
  membershipLabel?: string;
  priceLabel?: string;
  upgradeId?: string;
  upgradeLabel?: string;
  upgradePrice?: string;
}

export function loadPlanInfoFromDetailLog(): PlanInfoFallback | null {
  if (!fs.existsSync(DETAIL_LOG_FILE)) {
    return null;
  }
  const st = fs.statSync(DETAIL_LOG_FILE);
  const max = 2 * 1024 * 1024;
  const fd = fs.openSync(DETAIL_LOG_FILE, 'r');
  try {
    const start = Math.max(0, st.size - max);
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.includes('GetPlanInfo')) {
        continue;
      }
      try {
        const entry = JSON.parse(line) as {
          resBody?: string;
          resBodyEncoding?: string;
          resBodyBytes?: number;
        };
        if (!entry.resBody || !entry.resBodyBytes) {
          continue;
        }
        const raw =
          entry.resBodyEncoding === 'base64'
            ? Buffer.from(entry.resBody, 'base64')
            : Buffer.from(entry.resBody, 'utf8');
        const strs = raw.toString('latin1').match(/[\x20-\x7e]{3,}/g) || [];
        const out: PlanInfoFallback = {};
        for (const s of strs) {
          if (/^\$\d+\/mo/.test(s) && !out.priceLabel) {
            out.priceLabel = s;
          }
          if (s === 'Pro' || s === 'Pro+' || s === 'Ultra') {
            out.membershipLabel = s;
          }
          if (s === 'pro_plus') {
            out.upgradeId = s;
          }
          if (s.includes('Unlock') && s.length < 80) {
            out.upgradeLabel = s;
          }
        }
        if (out.priceLabel || out.membershipLabel) {
          return out;
        }
      } catch {
        // continue
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return null;
}
