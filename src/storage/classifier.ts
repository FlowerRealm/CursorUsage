export type RequestCategory =
  | 'chat'
  | 'agent'
  | 'tab'
  | 'usage'
  | 'indexing'
  | 'telemetry'
  | 'auth'
  | 'update'
  | 'other';

/** Categories that count as AI usage and are written to the log. */
export const AI_CATEGORIES: RequestCategory[] = ['chat', 'agent', 'tab'];

export interface RawLogEntry {
  t: number;
  url: string;
  m: string;
  s: number;
  type?: string;
  source?: string;
}

export interface RequestRecord {
  timestamp: number;
  url: string;
  host: string;
  path: string;
  method: string;
  statusCode: number;
  resourceType: string;
  category: RequestCategory;
}

/**
 * Classify a Cursor API path.
 * Only chat / agent / tab represent AI usage; everything else is noise.
 */
export function categorize(host: string, urlPath: string): RequestCategory {
  const h = host.toLowerCase();
  const p = urlPath.toLowerCase();

  if (h === 'metrics.cursor.sh' || p.startsWith('/tev1/')) {
    return 'telemetry';
  }
  if (p.includes('/auth/') || h.includes('authentication.cursor.sh') || h === 'authenticator.cursor.sh') {
    return 'auth';
  }
  if (p.includes('/updates/')) {
    return 'update';
  }
  if (h === 'repo42.cursor.sh') {
    return 'indexing';
  }

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

  // Dedicated agent backends
  if (h.endsWith('.api5.cursor.sh') || h === 'api5.cursor.sh') {
    return 'agent';
  }

  if (h === 'api2.cursor.sh' || h.endsWith('.api2.cursor.sh')) {
    // Tab / inline completion
    if (
      p.includes('tabservice') ||
      p.includes('cppservice') ||
      p.includes('/cpp') ||
      p.includes('complete')
    ) {
      return 'tab';
    }
    // Explicit agent RPCs
    if (p.includes('agentservice') || p.includes('backgroundcomposerservice')) {
      return 'agent';
    }
    // Streaming / chat conversation transport
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
    // Remaining aiserver noise (Analytics, Dashboard, GetDefaultModel, …) → other
    return 'other';
  }

  // Legacy tab endpoints on api3/api4 (non-telemetry)
  if ((h === 'api3.cursor.sh' || h === 'api4.cursor.sh') && !p.startsWith('/tev1/')) {
    if (p.includes('aiserver') || p.includes('cpp') || p.includes('tab') || p.includes('complete')) {
      return 'tab';
    }
  }

  return 'other';
}

export function isAiUsageCategory(category: RequestCategory): boolean {
  return (AI_CATEGORIES as string[]).includes(category);
}

export function parseLogEntry(entry: RawLogEntry): RequestRecord | null {
  if (!entry || typeof entry.t !== 'number' || typeof entry.url !== 'string') {
    return null;
  }
  let host = '';
  let urlPath = '';
  try {
    const u = new URL(entry.url);
    host = u.hostname;
    urlPath = u.pathname;
  } catch {
    return null;
  }
  const category = categorize(host, urlPath);
  // Only persist AI usage categories into analytics DB
  if (!isAiUsageCategory(category)) {
    return null;
  }
  return {
    timestamp: entry.t,
    url: entry.url,
    host,
    path: urlPath,
    method: entry.m || 'POST',
    statusCode: entry.s ?? 0,
    resourceType: entry.type || 'other',
    category
  };
}
