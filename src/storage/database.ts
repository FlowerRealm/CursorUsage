import * as fs from 'fs';
import type { Database, SqlJsStatic } from 'sql.js';
import { DB_FILE, ensureDataDir } from '../patcher';
import { RequestRecord } from './classifier';

let SQL: SqlJsStatic | null = null;
let db: Database | null = null;

export async function initDatabase(_extensionPath: string): Promise<Database> {
  if (db) {
    return db;
  }
  ensureDataDir();

  // Use asm.js build — no wasm file needed in the extension host
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const initSqlJsAsm = require('sql.js/dist/sql-asm.js');
  SQL = await initSqlJsAsm();

  if (fs.existsSync(DB_FILE)) {
    const buf = fs.readFileSync(DB_FILE);
    db = new SQL!.Database(buf);
  } else {
    db = new SQL!.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      url TEXT NOT NULL,
      host TEXT NOT NULL,
      path TEXT,
      method TEXT DEFAULT 'POST',
      status_code INTEGER,
      resource_type TEXT,
      category TEXT NOT NULL DEFAULT 'other'
    );
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_requests_category ON requests(category);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_requests_host ON requests(host);`);

  db.run(`
    CREATE TABLE IF NOT EXISTS billing_period (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT '',
      fetched_at INTEGER NOT NULL,
      source TEXT,
      raw_json TEXT,
      billing_cycle_start INTEGER,
      billing_cycle_end INTEGER,
      membership_type TEXT,
      total_spend_cents INTEGER,
      included_spend_cents INTEGER,
      bonus_spend_cents INTEGER,
      limit_cents INTEGER,
      remaining_cents INTEGER,
      auto_percent REAL,
      api_percent REAL,
      total_percent REAL,
      display_message TEXT,
      plan_message TEXT,
      api_message TEXT
    );
  `);

  // Migrate old single-row billing_period (no user_id column) to new schema
  try {
    const info = db.exec("PRAGMA table_info('billing_period')");
    if (info.length && info[0].values.length) {
      const columns = info[0].values.map((v: Array<unknown>) => String(v[1]));
      if (!columns.includes('user_id')) {
        // Old schema detected — migrate data then recreate
        const oldRow = db.exec(
          "SELECT fetched_at, source, raw_json, billing_cycle_start, billing_cycle_end, membership_type, total_spend_cents, included_spend_cents, bonus_spend_cents, limit_cents, remaining_cents, auto_percent, api_percent, total_percent, display_message, plan_message, api_message FROM billing_period WHERE id = 1"
        );
        const oldValues = (
          oldRow.length && oldRow[0].values.length ? oldRow[0].values[0] : null
        ) as import('sql.js').SqlValue[] | null;

        db.run(`DROP TABLE billing_period`);
        db.run(`
          CREATE TABLE billing_period (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL DEFAULT '',
            fetched_at INTEGER NOT NULL,
            source TEXT,
            raw_json TEXT,
            billing_cycle_start INTEGER,
            billing_cycle_end INTEGER,
            membership_type TEXT,
            total_spend_cents INTEGER,
            included_spend_cents INTEGER,
            bonus_spend_cents INTEGER,
            limit_cents INTEGER,
            remaining_cents INTEGER,
            auto_percent REAL,
            api_percent REAL,
            total_percent REAL,
            display_message TEXT,
            plan_message TEXT,
            api_message TEXT
          );
        `);

        if (oldValues) {
          const stmt = db.prepare(
            `INSERT INTO billing_period (user_id, fetched_at, source, raw_json, billing_cycle_start, billing_cycle_end, membership_type, total_spend_cents, included_spend_cents, bonus_spend_cents, limit_cents, remaining_cents, auto_percent, api_percent, total_percent, display_message, plan_message, api_message)
             VALUES ('',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          );
          stmt.bind(oldValues);
          stmt.step();
          stmt.free();
        }
      }
    }
  } catch {
    // migration is best-effort; new installs are handled by CREATE TABLE IF NOT EXISTS above
  }

  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_period_user_cycle ON billing_period(user_id, billing_cycle_start);`);

  db.run(`
    CREATE TABLE IF NOT EXISTS usage_events (
      event_key TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      model TEXT,
      kind TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      total_cents REAL,
      charged_cents REAL,
      requests_costs REAL,
      conversation_id TEXT,
      raw_json TEXT
    );
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_usage_events_timestamp ON usage_events(timestamp);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_usage_events_model ON usage_events(model);`);

  persist();
  return db;
}

export function getDb(): Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase first.');
  }
  return db;
}

export function persist(): void {
  if (!db) {
    return;
  }
  ensureDataDir();
  const data = db.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}

export function insertRequests(records: RequestRecord[]): number {
  if (records.length === 0) {
    return 0;
  }
  const database = getDb();
  const stmt = database.prepare(
    `INSERT INTO requests (timestamp, url, host, path, method, status_code, resource_type, category)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  database.run('BEGIN');
  try {
    for (const r of records) {
      stmt.bind([
        r.timestamp,
        r.url,
        r.host,
        r.path,
        r.method,
        r.statusCode,
        r.resourceType,
        r.category
      ]);
      stmt.step();
      stmt.reset();
    }
    database.run('COMMIT');
  } catch (e) {
    database.run('ROLLBACK');
    throw e;
  } finally {
    stmt.free();
  }
  persist();
  return records.length;
}

export function getTotalCount(aiOnly: boolean): number {
  const database = getDb();
  const sql = aiOnly
    ? `SELECT COUNT(*) as c FROM requests WHERE category IN ('chat','agent','tab')`
    : `SELECT COUNT(*) as c FROM requests`;
  const result = database.exec(sql);
  return (result[0]?.values[0]?.[0] as number) ?? 0;
}

export function closeDatabase(): void {
  if (db) {
    persist();
    db.close();
    db = null;
  }
}

export interface BillingPeriodRow {
  userId: string;
  fetchedAt: number;
  source: string;
  rawJson: string;
  billingCycleStart: number | null;
  billingCycleEnd: number | null;
  membershipType: string | null;
  totalSpendCents: number | null;
  includedSpendCents: number | null;
  bonusSpendCents: number | null;
  limitCents: number | null;
  remainingCents: number | null;
  autoPercent: number | null;
  apiPercent: number | null;
  totalPercent: number | null;
  displayMessage: string | null;
  planMessage: string | null;
  apiMessage: string | null;
}

export function upsertBillingPeriod(row: BillingPeriodRow): void {
  const database = getDb();
  database.run(
    `INSERT INTO billing_period (
      user_id, fetched_at, source, raw_json, billing_cycle_start, billing_cycle_end,
      membership_type, total_spend_cents, included_spend_cents, bonus_spend_cents,
      limit_cents, remaining_cents, auto_percent, api_percent, total_percent,
      display_message, plan_message, api_message
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id, billing_cycle_start) DO UPDATE SET
      fetched_at=excluded.fetched_at,
      source=excluded.source,
      raw_json=excluded.raw_json,
      billing_cycle_end=excluded.billing_cycle_end,
      membership_type=excluded.membership_type,
      total_spend_cents=excluded.total_spend_cents,
      included_spend_cents=excluded.included_spend_cents,
      bonus_spend_cents=excluded.bonus_spend_cents,
      limit_cents=excluded.limit_cents,
      remaining_cents=excluded.remaining_cents,
      auto_percent=excluded.auto_percent,
      api_percent=excluded.api_percent,
      total_percent=excluded.total_percent,
      display_message=excluded.display_message,
      plan_message=excluded.plan_message,
      api_message=excluded.api_message`,
    [
      row.userId || '',
      row.fetchedAt,
      row.source,
      row.rawJson,
      row.billingCycleStart,
      row.billingCycleEnd,
      row.membershipType,
      row.totalSpendCents,
      row.includedSpendCents,
      row.bonusSpendCents,
      row.limitCents,
      row.remainingCents,
      row.autoPercent,
      row.apiPercent,
      row.totalPercent,
      row.displayMessage,
      row.planMessage,
      row.apiMessage
    ]
  );
  persist();
}

/** Get the most recent billing period (regardless of account). */
export function getLatestBillingPeriod(): BillingPeriodRow | null {
  const database = getDb();
  const result = database.exec(
    `SELECT user_id, fetched_at, source, raw_json, billing_cycle_start, billing_cycle_end,
            membership_type, total_spend_cents, included_spend_cents, bonus_spend_cents,
            limit_cents, remaining_cents, auto_percent, api_percent, total_percent,
            display_message, plan_message, api_message
     FROM billing_period ORDER BY fetched_at DESC LIMIT 1`
  );
  if (!result[0]?.values?.[0]) {
    return null;
  }
  const v = result[0].values[0];
  return {
    userId: String(v[0] ?? ''),
    fetchedAt: v[1] as number,
    source: String(v[2] ?? ''),
    rawJson: String(v[3] ?? ''),
    billingCycleStart: (v[4] as number) ?? null,
    billingCycleEnd: (v[5] as number) ?? null,
    membershipType: (v[6] as string) ?? null,
    totalSpendCents: (v[7] as number) ?? null,
    includedSpendCents: (v[8] as number) ?? null,
    bonusSpendCents: (v[9] as number) ?? null,
    limitCents: (v[10] as number) ?? null,
    remainingCents: (v[11] as number) ?? null,
    autoPercent: (v[12] as number) ?? null,
    apiPercent: (v[13] as number) ?? null,
    totalPercent: (v[14] as number) ?? null,
    displayMessage: (v[15] as string) ?? null,
    planMessage: (v[16] as string) ?? null,
    apiMessage: (v[17] as string) ?? null
  };
}

/** Get billing period for a specific user and cycle, or null if not cached. */
export function getBillingPeriod(userId: string, cycleStart: number): BillingPeriodRow | null {
  const database = getDb();
  const stmt = database.prepare(
    `SELECT user_id, fetched_at, source, raw_json, billing_cycle_start, billing_cycle_end,
            membership_type, total_spend_cents, included_spend_cents, bonus_spend_cents,
            limit_cents, remaining_cents, auto_percent, api_percent, total_percent,
            display_message, plan_message, api_message
     FROM billing_period WHERE user_id = ? AND billing_cycle_start = ?`
  );
  stmt.bind([userId, cycleStart]);
  let row: BillingPeriodRow | null = null;
  if (stmt.step()) {
    const v = stmt.get();
    row = {
      userId: String(v[0] ?? ''),
      fetchedAt: v[1] as number,
      source: String(v[2] ?? ''),
      rawJson: String(v[3] ?? ''),
      billingCycleStart: (v[4] as number) ?? null,
      billingCycleEnd: (v[5] as number) ?? null,
      membershipType: (v[6] as string) ?? null,
      totalSpendCents: (v[7] as number) ?? null,
      includedSpendCents: (v[8] as number) ?? null,
      bonusSpendCents: (v[9] as number) ?? null,
      limitCents: (v[10] as number) ?? null,
      remainingCents: (v[11] as number) ?? null,
      autoPercent: (v[12] as number) ?? null,
      apiPercent: (v[13] as number) ?? null,
      totalPercent: (v[14] as number) ?? null,
      displayMessage: (v[15] as string) ?? null,
      planMessage: (v[16] as string) ?? null,
      apiMessage: (v[17] as string) ?? null
    };
  }
  stmt.free();
  return row;
}

export interface UsageEventRow {
  eventKey: string;
  timestamp: number;
  model: string;
  kind: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalCents: number | null;
  chargedCents: number | null;
  requestsCosts: number | null;
  conversationId: string | null;
  rawJson: string;
}

/** Merge events into local store — only insert if event_key is new (preserves existing data across accounts). */
export function mergeUsageEvents(rows: UsageEventRow[]): number {
  const database = getDb();
  let inserted = 0;
  database.run('BEGIN');
  try {
    const stmt = database.prepare(
      `INSERT OR IGNORE INTO usage_events (
        event_key, timestamp, model, kind, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, total_cents, charged_cents,
        requests_costs, conversation_id, raw_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    for (const r of rows) {
      stmt.bind([
        r.eventKey,
        r.timestamp,
        r.model,
        r.kind,
        r.inputTokens,
        r.outputTokens,
        r.cacheReadTokens,
        r.cacheWriteTokens,
        r.totalCents,
        r.chargedCents,
        r.requestsCosts,
        r.conversationId,
        r.rawJson
      ]);
      stmt.step();
      // sql.js returns SQLITE_DONE even for ignored rows; count by checking changes
      const changes = database.getRowsModified();
      if (changes > 0) inserted++;
      stmt.reset();
    }
    stmt.free();
    database.run('COMMIT');
  } catch (e) {
    database.run('ROLLBACK');
    throw e;
  }
  persist();
  return inserted;
}

export interface UsageEventStats {
  count: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  chargedCents: number;
  byModel: Array<{
    model: string;
    count: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    chargedCents: number;
  }>;
  recent: UsageEventRow[];
}

export function getUsageEventStats(limit = 20, rangeStart?: number, rangeEnd?: number): UsageEventStats {
  const database = getDb();
  const hasRange = rangeStart != null && rangeEnd != null;
  const whereClause = hasRange ? `WHERE timestamp >= ${rangeStart} AND timestamp <= ${rangeEnd}` : '';

  const countRow = database.exec(
    `SELECT COUNT(*),
            COALESCE(SUM(input_tokens),0),
            COALESCE(SUM(output_tokens),0),
            COALESCE(SUM(cache_read_tokens),0),
            COALESCE(SUM(cache_write_tokens),0),
            COALESCE(SUM(charged_cents),0)
     FROM usage_events ${whereClause}`
  );
  const c = countRow[0]?.values?.[0] || [0, 0, 0, 0, 0, 0];
  const byModelRows = database.exec(
    `SELECT model,
            COUNT(*),
            COALESCE(SUM(input_tokens),0),
            COALESCE(SUM(output_tokens),0),
            COALESCE(SUM(cache_read_tokens),0),
            COALESCE(SUM(cache_write_tokens),0),
            COALESCE(SUM(charged_cents),0)
     FROM usage_events ${whereClause}
     GROUP BY model
     ORDER BY COUNT(*) DESC
     LIMIT 12`
  );
  const byModel =
    byModelRows[0]?.values?.map((row) => ({
      model: String(row[0] ?? ''),
      count: row[1] as number,
      inputTokens: row[2] as number,
      outputTokens: row[3] as number,
      cacheReadTokens: row[4] as number,
      cacheWriteTokens: row[5] as number,
      chargedCents: row[6] as number
    })) || [];

  const recentRows = database.exec(
    `SELECT event_key, timestamp, model, kind, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, total_cents, charged_cents,
            requests_costs, conversation_id, raw_json
     FROM usage_events ${whereClause} ORDER BY timestamp DESC LIMIT ${Math.max(1, Math.min(limit, 500))}`
  );
  const recent: UsageEventRow[] =
    recentRows[0]?.values?.map((row) => ({
      eventKey: String(row[0]),
      timestamp: row[1] as number,
      model: String(row[2] ?? ''),
      kind: (row[3] as string) ?? null,
      inputTokens: (row[4] as number) ?? null,
      outputTokens: (row[5] as number) ?? null,
      cacheReadTokens: (row[6] as number) ?? null,
      cacheWriteTokens: (row[7] as number) ?? null,
      totalCents: (row[8] as number) ?? null,
      chargedCents: (row[9] as number) ?? null,
      requestsCosts: (row[10] as number) ?? null,
      conversationId: (row[11] as string) ?? null,
      rawJson: String(row[12] ?? '')
    })) || [];

  return {
    count: c[0] as number,
    inputTokens: c[1] as number,
    outputTokens: c[2] as number,
    cacheReadTokens: c[3] as number,
    cacheWriteTokens: c[4] as number,
    chargedCents: c[5] as number,
    byModel,
    recent
  };
}
