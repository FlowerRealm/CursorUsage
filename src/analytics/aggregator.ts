import { getDb, getLatestBillingPeriod, getUsageEventStats, BillingPeriodRow, UsageEventStats } from '../storage/database';
import { AI_CATEGORIES, RequestCategory } from '../storage/classifier';

export type ViewMode = 'day' | 'week' | 'month' | 'year';

export interface BucketPoint {
  label: string;
  category: string;
  count: number;
}

export interface PieSlice {
  name: string;
  value: number;
}

export interface KpiData {
  total: number;
  dailyAvg: number;
  peakLabel: string;
  peakCount: number;
}

export interface BillingDashboard {
  period: BillingPeriodRow | null;
  events: UsageEventStats;
  planHint?: string;
}

export interface DashboardData {
  view: ViewMode;
  aiOnly: boolean;
  buckets: BucketPoint[];
  pie: PieSlice[];
  kpi: KpiData;
  rangeStart: number;
  rangeEnd: number;
  billing: BillingDashboard;
}

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function getRange(view: ViewMode, now = new Date()): { start: number; end: number } {
  if (view === 'day') {
    const start = startOfLocalDay(now).getTime();
    return { start, end: start + 24 * 60 * 60 * 1000 - 1 };
  }
  if (view === 'week') {
    const day = now.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = startOfLocalDay(now);
    monday.setDate(monday.getDate() + mondayOffset);
    return { start: monday.getTime(), end: monday.getTime() + 7 * 24 * 60 * 60 * 1000 - 1 };
  }
  if (view === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
    return { start, end: next - 1 };
  }
  const start = new Date(now.getFullYear(), 0, 1).getTime();
  const next = new Date(now.getFullYear() + 1, 0, 1).getTime();
  return { start, end: next - 1 };
}

function categoryFilterSql(aiOnly: boolean): string {
  return aiOnly ? `AND category IN ('chat','agent','tab')` : '';
}

function bucketKey(ts: number, view: ViewMode): string {
  const d = new Date(ts);
  if (view === 'day') {
    return String(d.getHours()).padStart(2, '0');
  }
  if (view === 'week') {
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return names[d.getDay()];
  }
  if (view === 'month') {
    return String(d.getDate()).padStart(2, '0');
  }
  return String(d.getMonth() + 1).padStart(2, '0');
}

function allLabels(view: ViewMode, rangeStart: number): string[] {
  if (view === 'day') {
    return Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
  }
  if (view === 'week') {
    return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  }
  if (view === 'month') {
    const d = new Date(rangeStart);
    const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    return Array.from({ length: days }, (_, i) => String(i + 1).padStart(2, '0'));
  }
  return Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
}

function queryRows(
  sql: string,
  params: Array<string | number>
): Array<Array<string | number | null>> {
  const database = getDb();
  const stmt = database.prepare(sql);
  stmt.bind(params);
  const rows: Array<Array<string | number | null>> = [];
  while (stmt.step()) {
    const row = stmt.get();
    rows.push(row as Array<string | number | null>);
  }
  stmt.free();
  return rows;
}

export function getDashboardData(view: ViewMode, aiOnly: boolean): DashboardData {
  const { start, end } = getRange(view);
  const filter = categoryFilterSql(aiOnly);

  const rawRows = queryRows(
    `SELECT timestamp, category FROM requests
     WHERE timestamp >= ? AND timestamp <= ? ${filter}`,
    [start, end]
  );

  const counts = new Map<string, number>();
  const categoryTotals = new Map<string, number>();
  const labelTotals = new Map<string, number>();

  for (const row of rawRows) {
    const ts = row[0] as number;
    const category = row[1] as string;
    const label = bucketKey(ts, view);
    const key = `${label}|${category}`;
    counts.set(key, (counts.get(key) || 0) + 1);
    categoryTotals.set(category, (categoryTotals.get(category) || 0) + 1);
    labelTotals.set(label, (labelTotals.get(label) || 0) + 1);
  }

  const labels = allLabels(view, start);
  const categories: string[] = aiOnly
    ? [...AI_CATEGORIES]
    : (['chat', 'agent', 'tab', 'indexing', 'telemetry', 'auth', 'update', 'other'] as RequestCategory[]);

  const buckets: BucketPoint[] = [];
  for (const label of labels) {
    for (const category of categories) {
      buckets.push({
        label,
        category,
        count: counts.get(`${label}|${category}`) || 0
      });
    }
  }

  const pie: PieSlice[] = [...categoryTotals.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  const total = [...categoryTotals.values()].reduce((a, b) => a + b, 0);

  let peakLabel = '-';
  let peakCount = 0;
  for (const [label, count] of labelTotals) {
    if (count > peakCount) {
      peakCount = count;
      peakLabel = label;
    }
  }
  if (view === 'day' && peakLabel !== '-') {
    peakLabel = `${peakLabel}:00`;
  } else if (view === 'month' && peakLabel !== '-') {
    peakLabel = `Day ${peakLabel}`;
  } else if (view === 'year' && peakLabel !== '-') {
    peakLabel = `Month ${peakLabel}`;
  }

  let dailyAvg = 0;
  if (view === 'day') {
    dailyAvg = total;
  } else if (view === 'week') {
    dailyAvg = total / 7;
  } else if (view === 'month') {
    const days = new Date(new Date(start).getFullYear(), new Date(start).getMonth() + 1, 0).getDate();
    dailyAvg = total / days;
  } else {
    dailyAvg = total / 365;
  }

  return {
    view,
    aiOnly,
    buckets,
    pie,
    kpi: {
      total,
      dailyAvg: Math.round(dailyAvg * 10) / 10,
      peakLabel,
      peakCount
    },
    rangeStart: start,
    rangeEnd: end,
    billing: {
      period: getLatestBillingPeriod(),
      events: getUsageEventStats(500, start, end)
    }
  };
}

export function exportCsv(aiOnly: boolean): string {
  const filter = categoryFilterSql(aiOnly);
  const rows = queryRows(
    `SELECT timestamp, url, host, path, method, status_code, resource_type, category
     FROM requests WHERE 1=1 ${filter} ORDER BY timestamp ASC`,
    []
  );
  const header = 'timestamp,datetime,url,host,path,method,status_code,resource_type,category';
  const lines = [header];
  for (const row of rows) {
    const [ts, url, host, path, method, status, rtype, category] = row;
    const dt = new Date(ts as number).toISOString();
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    lines.push(
      [ts, dt, esc(url), esc(host), esc(path), method, status, rtype, category].join(',')
    );
  }
  return lines.join('\n') + '\n';
}
