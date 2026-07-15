import * as fs from 'fs';
import * as path from 'path';
import { loadCursorCredentials, CursorCredentials } from './credentials';
import {
  fetchCurrentPeriodUsage,
  fetchUsageSummary,
  fetchAllUsageEvents,
  periodFromSummary,
  PeriodUsageResponse,
  UsageEvent
} from './cursorApi';
import {
  upsertBillingPeriod,
  mergeUsageEvents,
  getLatestBillingPeriod,
  BillingPeriodRow,
  UsageEventRow
} from '../storage/database';
import { DATA_DIR, TOKENS_LOG_FILE, ensureDataDir } from '../paths';

const LOCAL_CACHE_TTL_MS = 30 * 60 * 1000;

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
  const planUsage = period.planUsage;
  const start = Number(period.billingCycleStart) || Date.parse(period.billingCycleStart) || 0;
  const end = Number(period.billingCycleEnd) || Date.parse(period.billingCycleEnd) || 0;
  const limit = planUsage?.limit ?? 0;
  const included = planUsage?.includedSpend ?? 0;
  const remaining =
    planUsage?.remaining != null
      ? planUsage.remaining
      : limit > 0
        ? Math.max(0, limit - included)
        : undefined;
  return {
    userId,
    fetchedAt: Date.now(),
    source,
    rawJson: JSON.stringify(period),
    billingCycleStart: start || null,
    billingCycleEnd: end || null,
    membershipType: membershipType || null,
    totalSpendCents: planUsage?.totalSpend ?? null,
    includedSpendCents: included || null,
    bonusSpendCents: planUsage?.bonusSpend ?? null,
    limitCents: limit || null,
    remainingCents: remaining ?? null,
    autoPercent: planUsage?.autoPercentUsed ?? null,
    apiPercent: planUsage?.apiPercentUsed ?? null,
    totalPercent: planUsage?.totalPercentUsed ?? null,
    displayMessage: period.displayMessage || null,
    planMessage: period.autoModelSelectedDisplayMessage || null,
    apiMessage: period.namedModelSelectedDisplayMessage || null
  };
}

function eventKey(event: UsageEvent): string {
  return [
    event.timestamp || '',
    event.model || '',
    event.conversationId || '',
    event.tokenUsage?.inputTokens ?? '',
    event.tokenUsage?.outputTokens ?? '',
    event.chargedCents ?? ''
  ].join('|');
}

function toEventRows(events: UsageEvent[]): UsageEventRow[] {
  return events.map((event) => ({
    eventKey: eventKey(event),
    timestamp: Number(event.timestamp) || 0,
    model: event.model || '',
    kind: event.kind || null,
    inputTokens: event.tokenUsage?.inputTokens ?? null,
    outputTokens: event.tokenUsage?.outputTokens ?? null,
    cacheReadTokens: event.tokenUsage?.cacheReadTokens ?? null,
    cacheWriteTokens: event.tokenUsage?.cacheWriteTokens ?? null,
    totalCents: event.tokenUsage?.totalCents ?? null,
    chargedCents: event.chargedCents ?? null,
    requestsCosts: event.requestsCosts ?? null,
    conversationId: event.conversationId || null,
    rawJson: JSON.stringify(event)
  }));
}

function writeTokensLog(events: UsageEvent[]): void {
  ensureDataDir();
  const lines = events.map((event) =>
    JSON.stringify({
      t: Number(event.timestamp) || 0,
      model: event.model || '',
      kind: event.kind || null,
      conversationId: event.conversationId || null,
      chargedCents: event.chargedCents ?? null,
      requestsCosts: event.requestsCosts ?? null,
      tokenUsage: event.tokenUsage ?? null,
      event: 'token'
    })
  );
  const temporaryPath = path.join(DATA_DIR, 'usage-tokens.jsonl.tmp');
  fs.writeFileSync(temporaryPath, lines.length ? lines.join('\n') + '\n' : '', 'utf8');
  fs.renameSync(temporaryPath, TOKENS_LOG_FILE);
}

async function fetchPeriod(
  credentials: CursorCredentials,
  warnings: string[]
): Promise<{ period: PeriodUsageResponse; source: string } | null> {
  try {
    const period = await fetchCurrentPeriodUsage(credentials);
    return { period, source: 'api2-GetCurrentPeriodUsage' };
  } catch (error) {
    warnings.push(`api2 period: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const summary = await fetchUsageSummary(credentials);
    const period = periodFromSummary(summary);
    if (period) {
      return { period, source: 'cursor.com-usage-summary' };
    }
    warnings.push('usage-summary: no plan block');
  } catch (error) {
    warnings.push(`usage-summary: ${error instanceof Error ? error.message : String(error)}`);
  }

  return null;
}

/**
 * Local-first billing sync from official Cursor APIs using local auth.
 * Merges events (never deletes) so multi-account history can coexist.
 *
 * @param forceRefresh Skip local cache and re-fetch from upstream.
 */
export async function syncBilling(forceRefresh = false): Promise<BillingSyncResult> {
  const warnings: string[] = [];
  let credentials: CursorCredentials;
  try {
    credentials = await loadCursorCredentials();
  } catch (error) {
    return {
      ok: false,
      source: 'none',
      eventsImported: 0,
      error: error instanceof Error ? error.message : String(error),
      warnings
    };
  }

  const membership = credentials.membershipType;
  const userId = credentials.userId;

  if (!forceRefresh) {
    const cached = getLatestBillingPeriod();
    if (
      cached &&
      cached.userId === userId &&
      Date.now() - cached.fetchedAt < LOCAL_CACHE_TTL_MS
    ) {
      return {
        ok: true,
        source: `local:${cached.source}`,
        period: cached,
        eventsImported: 0,
        planHint: membership || undefined,
        warnings
      };
    }
  }

  const fetched = await fetchPeriod(credentials, warnings);
  if (!fetched) {
    return {
      ok: false,
      source: 'none',
      eventsImported: 0,
      error: 'Could not load period usage from official APIs',
      warnings
    };
  }

  const periodRow = toPeriodRow(fetched.period, fetched.source, userId, membership);
  upsertBillingPeriod(periodRow);

  let eventsImported = 0;
  let eventsTotal: number | undefined;
  try {
    const startDate = periodRow.billingCycleStart
      ? String(periodRow.billingCycleStart)
      : undefined;
    const { total, events } = await fetchAllUsageEvents(credentials, {
      pageSize: 200,
      maxPages: 15,
      startDate
    });
    eventsTotal = total;
    eventsImported = mergeUsageEvents(toEventRows(events));
    try {
      writeTokensLog(events);
    } catch (error) {
      warnings.push(`tokens-log: ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch (error) {
    warnings.push(`usage-events: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    ok: true,
    source: fetched.source,
    period: periodRow,
    eventsImported,
    eventsTotal,
    planHint: membership || undefined,
    warnings
  };
}
