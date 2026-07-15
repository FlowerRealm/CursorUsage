import * as fs from 'fs';
import * as path from 'path';
import {
  loadCursorCredentials,
  CursorCredentials
} from './credentials';
import {
  fetchCurrentPeriodUsage,
  fetchUsageSummary,
  fetchAllUsageEvents,
  periodFromSummary,
  PeriodUsageResponse,
  UsageEvent
} from './cursorApi';
import { loadPeriodUsageFromDetailLog, loadPlanInfoFromDetailLog } from './protoFallback';
import {
  upsertBillingPeriod,
  mergeUsageEvents,
  getBillingPeriod,
  BillingPeriodRow,
  UsageEventRow
} from '../storage/database';
import {
  DATA_DIR,
  TOKENS_LOG_FILE,
  enableDetailLogging,
  isDetailLoggingEnabled
} from '../patcher';

export interface BillingSyncResult {
  ok: boolean;
  source: string;
  period?: BillingPeriodRow;
  eventsImported: number;
  eventsTotal?: number;
  planHint?: string;
  error?: string;
  warnings: string[];
}

function toPeriodRow(
  period: PeriodUsageResponse,
  source: string,
  userId: string,
  membershipType?: string
): BillingPeriodRow {
  const pu = period.planUsage;
  const start = Number(period.billingCycleStart) || Date.parse(period.billingCycleStart) || 0;
  const end = Number(period.billingCycleEnd) || Date.parse(period.billingCycleEnd) || 0;
  const limit = pu?.limit ?? 0;
  const included = pu?.includedSpend ?? 0;
  const remaining =
    pu?.remaining != null ? pu.remaining : limit > 0 ? Math.max(0, limit - included) : undefined;
  return {
    userId,
    fetchedAt: Date.now(),
    source,
    rawJson: JSON.stringify(period),
    billingCycleStart: start || null,
    billingCycleEnd: end || null,
    membershipType: membershipType || null,
    totalSpendCents: pu?.totalSpend ?? null,
    includedSpendCents: included || null,
    bonusSpendCents: pu?.bonusSpend ?? null,
    limitCents: limit || null,
    remainingCents: remaining ?? null,
    autoPercent: pu?.autoPercentUsed ?? null,
    apiPercent: pu?.apiPercentUsed ?? null,
    totalPercent: pu?.totalPercentUsed ?? null,
    displayMessage: period.displayMessage || null,
    planMessage: period.autoModelSelectedDisplayMessage || null,
    apiMessage: period.namedModelSelectedDisplayMessage || null
  };
}

function eventKey(e: UsageEvent): string {
  return [
    e.timestamp || '',
    e.model || '',
    e.conversationId || '',
    e.tokenUsage?.inputTokens ?? '',
    e.tokenUsage?.outputTokens ?? '',
    e.chargedCents ?? ''
  ].join('|');
}

function toEventRows(events: UsageEvent[]): UsageEventRow[] {
  return events.map((e) => ({
    eventKey: eventKey(e),
    timestamp: Number(e.timestamp) || 0,
    model: e.model || '',
    kind: e.kind || null,
    inputTokens: e.tokenUsage?.inputTokens ?? null,
    outputTokens: e.tokenUsage?.outputTokens ?? null,
    cacheReadTokens: e.tokenUsage?.cacheReadTokens ?? null,
    cacheWriteTokens: e.tokenUsage?.cacheWriteTokens ?? null,
    totalCents: e.tokenUsage?.totalCents ?? null,
    chargedCents: e.chargedCents ?? null,
    requestsCosts: e.requestsCosts ?? null,
    conversationId: e.conversationId || null,
    rawJson: JSON.stringify(e)
  }));
}

/**
 * Persist each event's full tokenUsage (+ identity) to usage-tokens.jsonl.
 * Does NOT write into requests-detail.jsonl (detail capture stays independent).
 */
function writeTokensLog(events: UsageEvent[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const lines = events.map((e) =>
    JSON.stringify({
      t: Number(e.timestamp) || 0,
      model: e.model || '',
      kind: e.kind || null,
      conversationId: e.conversationId || null,
      chargedCents: e.chargedCents ?? null,
      requestsCosts: e.requestsCosts ?? null,
      tokenUsage: e.tokenUsage ?? null,
      event: 'token'
    })
  );
  const tmp = path.join(DATA_DIR, 'usage-tokens.jsonl.tmp');
  fs.writeFileSync(tmp, lines.length ? lines.join('\n') + '\n' : '', 'utf8');
  fs.renameSync(tmp, TOKENS_LOG_FILE);
}

/** Keep detail logging on; billing/token sync must not turn it off. */
function ensureDetailStaysOn(): void {
  if (!isDetailLoggingEnabled()) {
    enableDetailLogging();
  }
}

async function fetchPeriod(
  creds: CursorCredentials,
  warnings: string[]
): Promise<{ period: PeriodUsageResponse; source: string } | null> {
  try {
    const period = await fetchCurrentPeriodUsage(creds);
    return { period, source: 'api2-GetCurrentPeriodUsage' };
  } catch (e) {
    warnings.push(`api2 period: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const summary = await fetchUsageSummary(creds);
    const period = periodFromSummary(summary);
    if (period) {
      return { period, source: 'cursor.com-usage-summary' };
    }
    warnings.push('usage-summary: no plan block');
  } catch (e) {
    warnings.push(`usage-summary: ${e instanceof Error ? e.message : String(e)}`);
  }
  const proto = loadPeriodUsageFromDetailLog();
  if (proto) {
    return { period: proto, source: 'detail-log-proto' };
  }
  warnings.push('proto fallback: no GetCurrentPeriodUsage body found');
  return null;
}

/**
 * Local-first billing sync: checks local DB first, only fetches from upstream
 * when data is missing. Uses merge (never delete) for events so multi-account
 * data coexists.
 *
 * @param forceRefresh  Skip local cache and re-fetch from upstream (still merges, never deletes).
 */
export async function syncBilling(forceRefresh = false): Promise<BillingSyncResult> {
  ensureDetailStaysOn();
  const warnings: string[] = [];
  let creds: CursorCredentials;
  try {
    creds = await loadCursorCredentials();
  } catch (e) {
    // Still try proto-only offline path
    const proto = loadPeriodUsageFromDetailLog();
    if (proto) {
      const row = toPeriodRow(proto, 'detail-log-proto', '');
      upsertBillingPeriod(row);
      const plan = loadPlanInfoFromDetailLog();
      return {
        ok: true,
        source: 'detail-log-proto',
        period: row,
        eventsImported: 0,
        planHint: plan?.priceLabel || plan?.membershipLabel,
        warnings: [`credentials: ${e instanceof Error ? e.message : String(e)}`]
      };
    }
    return {
      ok: false,
      source: 'none',
      eventsImported: 0,
      error: e instanceof Error ? e.message : String(e),
      warnings
    };
  }

  // --- Local-first: check if we already have this account+cycle cached ---
  const membership = creds.membershipType;
  const userId = creds.userId;

  if (!forceRefresh) {
    // Try to get the billing period from the detail log first to know the cycle
    const proto = loadPeriodUsageFromDetailLog();
    const protoStart = proto ? (Number(proto.billingCycleStart) || Date.parse(proto.billingCycleStart) || 0) : 0;

    if (protoStart) {
      const cached = getBillingPeriod(userId, protoStart);
      if (cached) {
        // We already have local data for this account+cycle — serve from local
        const plan = loadPlanInfoFromDetailLog();
        return {
          ok: true,
          source: `local:${cached.source}`,
          period: cached,
          eventsImported: 0,
          planHint: plan
            ? [plan.membershipLabel, plan.priceLabel].filter(Boolean).join(' ')
            : membership || undefined,
          warnings
        };
      }
    }
  }

  // --- No local data (or force refresh) — fetch from upstream ---
  const fetched = await fetchPeriod(creds, warnings);
  if (!fetched) {
    return {
      ok: false,
      source: 'none',
      eventsImported: 0,
      error: 'Could not load period usage from API or detail log',
      warnings
    };
  }

  const row = toPeriodRow(fetched.period, fetched.source, userId, membership);
  upsertBillingPeriod(row);

  let eventsImported = 0;
  let eventsTotal: number | undefined;
  try {
    const startDate = row.billingCycleStart ? String(row.billingCycleStart) : undefined;
    const { total, events } = await fetchAllUsageEvents(creds, {
      pageSize: 200,
      maxPages: 15,
      startDate
    });
    eventsTotal = total;
    eventsImported = mergeUsageEvents(toEventRows(events));
    try {
      writeTokensLog(events);
    } catch (e) {
      warnings.push(`tokens-log: ${e instanceof Error ? e.message : String(e)}`);
    }
  } catch (e) {
    warnings.push(`usage-events: ${e instanceof Error ? e.message : String(e)}`);
  }

  const plan = loadPlanInfoFromDetailLog();

  return {
    ok: true,
    source: fetched.source,
    period: row,
    eventsImported,
    eventsTotal,
    planHint: plan
      ? [plan.membershipLabel, plan.priceLabel].filter(Boolean).join(' ')
      : membership || undefined,
    warnings
  };
}
