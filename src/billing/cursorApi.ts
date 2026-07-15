import { CursorCredentials } from './credentials';

export interface PlanUsage {
  totalSpend: number;
  includedSpend: number;
  bonusSpend: number;
  remaining?: number;
  limit: number;
  remainingBonus?: boolean;
  bonusTooltip?: string;
  autoPercentUsed?: number;
  apiPercentUsed?: number;
  totalPercentUsed?: number;
}

export interface PeriodUsageResponse {
  billingCycleStart: string;
  billingCycleEnd: string;
  planUsage?: PlanUsage;
  spendLimitUsage?: Record<string, unknown>;
  displayThreshold?: number;
  enabled?: boolean;
  displayMessage?: string;
  autoModelSelectedDisplayMessage?: string;
  namedModelSelectedDisplayMessage?: string;
  autoBucketModels?: string[];
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalCents?: number;
  discountPercentOff?: number;
}

export interface UsageEvent {
  timestamp: string;
  model: string;
  kind?: string;
  requestsCosts?: number;
  usageBasedCosts?: string;
  isTokenBasedCall?: boolean;
  tokenUsage?: TokenUsage;
  owningUser?: string;
  cursorTokenFee?: number;
  isChargeable?: boolean;
  isHeadless?: boolean;
  chargedCents?: number;
  conversationId?: string;
  subscriptionProductId?: string;
}

export interface FilteredUsageEventsResponse {
  totalUsageEventsCount: number;
  usageEventsDisplay: UsageEvent[];
}

export interface UsageSummaryResponse {
  billingCycleStart?: string;
  billingCycleEnd?: string;
  membershipType?: string;
  limitType?: string;
  isUnlimited?: boolean;
  autoModelSelectedDisplayMessage?: string;
  namedModelSelectedDisplayMessage?: string;
  individualUsage?: {
    plan?: {
      enabled?: boolean;
      used?: number;
      limit?: number;
      remaining?: number;
      breakdown?: { included?: number; bonus?: number; total?: number };
      autoPercentUsed?: number;
      apiPercentUsed?: number;
      totalPercentUsed?: number;
    };
    onDemand?: { enabled?: boolean; used?: number; limit?: number | null };
  };
}

async function fetchJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
  const { timeoutMs = 25000, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
    }
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Connect JSON over api2 — account period usage (cents). */
export async function fetchCurrentPeriodUsage(
  creds: CursorCredentials
): Promise<PeriodUsageResponse> {
  return fetchJson<PeriodUsageResponse>(
    'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1'
      },
      body: '{}'
    }
  );
}

/** Web dashboard summary — cookie auth. */
export async function fetchUsageSummary(creds: CursorCredentials): Promise<UsageSummaryResponse> {
  return fetchJson<UsageSummaryResponse>('https://cursor.com/api/usage-summary', {
    method: 'GET',
    headers: {
      Cookie: `WorkosCursorSessionToken=${creds.workosCookie}`
    }
  });
}

/** Per-request token/cost events. */
export async function fetchFilteredUsageEvents(
  creds: CursorCredentials,
  opts: { page?: number; pageSize?: number; startDate?: string; endDate?: string } = {}
): Promise<FilteredUsageEventsResponse> {
  const body = {
    page: opts.page ?? 1,
    pageSize: opts.pageSize ?? 100,
    ...(opts.startDate ? { startDate: opts.startDate } : {}),
    ...(opts.endDate ? { endDate: opts.endDate } : {})
  };
  return fetchJson<FilteredUsageEventsResponse>(
    'https://cursor.com/api/dashboard/get-filtered-usage-events',
    {
      method: 'POST',
      headers: {
        Cookie: `WorkosCursorSessionToken=${creds.workosCookie}`,
        'Content-Type': 'application/json',
        Origin: 'https://cursor.com'
      },
      body: JSON.stringify(body)
    }
  );
}

/** Paginate events (newest first). Caps pages to avoid hammering. */
export async function fetchAllUsageEvents(
  creds: CursorCredentials,
  opts: { pageSize?: number; maxPages?: number; startDate?: string } = {}
): Promise<{ total: number; events: UsageEvent[] }> {
  const pageSize = opts.pageSize ?? 200;
  const maxPages = opts.maxPages ?? 10;
  const all: UsageEvent[] = [];
  let total = 0;
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetchFilteredUsageEvents(creds, {
      page,
      pageSize,
      startDate: opts.startDate
    });
    total = res.totalUsageEventsCount;
    const batch = res.usageEventsDisplay || [];
    all.push(...batch);
    if (batch.length < pageSize || all.length >= total) {
      break;
    }
  }
  return { total, events: all };
}

export function periodFromSummary(summary: UsageSummaryResponse): PeriodUsageResponse | null {
  const plan = summary.individualUsage?.plan;
  if (!plan) {
    return null;
  }
  const breakdown = plan.breakdown;
  return {
    billingCycleStart: summary.billingCycleStart
      ? String(Date.parse(summary.billingCycleStart) || summary.billingCycleStart)
      : '',
    billingCycleEnd: summary.billingCycleEnd
      ? String(Date.parse(summary.billingCycleEnd) || summary.billingCycleEnd)
      : '',
    planUsage: {
      totalSpend: breakdown?.total ?? plan.used ?? 0,
      includedSpend: breakdown?.included ?? plan.used ?? 0,
      bonusSpend: breakdown?.bonus ?? 0,
      remaining: plan.remaining,
      limit: plan.limit ?? 0,
      autoPercentUsed: plan.autoPercentUsed,
      apiPercentUsed: plan.apiPercentUsed,
      totalPercentUsed: plan.totalPercentUsed
    },
    enabled: plan.enabled,
    displayMessage: undefined,
    autoModelSelectedDisplayMessage: summary.autoModelSelectedDisplayMessage,
    namedModelSelectedDisplayMessage: summary.namedModelSelectedDisplayMessage
  };
}
