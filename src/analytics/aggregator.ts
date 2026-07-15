import {
  getLatestBillingPeriod,
  getUsageEventStats,
  exportUsageEventsCsv,
  BillingPeriodRow,
  UsageEventStats
} from '../storage/database';

export type ViewMode = 'day' | 'week' | 'month' | 'year';

export interface BillingDashboard {
  period: BillingPeriodRow | null;
  events: UsageEventStats;
  planHint?: string;
}

export interface DashboardData {
  view: ViewMode;
  rangeStart: number;
  rangeEnd: number;
  billing: BillingDashboard;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function getRange(view: ViewMode, now = new Date()): { start: number; end: number } {
  if (view === 'day') {
    const start = startOfLocalDay(now).getTime();
    return { start, end: start + 24 * 60 * 60 * 1000 - 1 };
  }
  if (view === 'week') {
    const dayOfWeek = now.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
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

export function getDashboardData(view: ViewMode): DashboardData {
  const { start, end } = getRange(view);
  const period = getLatestBillingPeriod();
  return {
    view,
    rangeStart: start,
    rangeEnd: end,
    billing: {
      period,
      events: getUsageEventStats(500, start, end),
      planHint: period?.membershipType || undefined
    }
  };
}

export function exportCsv(): string {
  return exportUsageEventsCsv();
}
