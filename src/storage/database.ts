import * as fs from 'fs';
import type { Database, SqlJsStatic } from 'sql.js';
import { DB_FILE, ensureDataDir } from '../paths';

let SQL: SqlJsStatic | null = null;
let db: Database | null = null;

const BILLING_SELECT = `SELECT user_id, fetched_at, source, raw_json, billing_cycle_start, billing_cycle_end,
            membership_type, total_spend_cents, included_spend_cents, bonus_spend_cents,
            limit_cents, remaining_cents, auto_percent, api_percent, total_percent,
            display_message, plan_message, api_message
     FROM billing_period`;

export async function initDatabase(_extensionPath: string): Promise<Database> {
  if (db) {
    return db;
  }
  ensureDataDir();

  // asm.js build — no wasm file needed in the extension host
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const initSqlJsAsm = require('sql.js/dist/sql-asm.js');
  SQL = await initSqlJsAsm();

  if (fs.existsSync(DB_FILE)) {
    const buffer = fs.readFileSync(DB_FILE);
    db = new SQL!.Database(buffer);
  } else {
    db = new SQL!.Database();
  }

  // Drop legacy capture table if present (request-hook path removed).
  try {
    db.run('DROP TABLE IF EXISTS requests');
  } catch {
    // ignore
  }

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

  // Migrate old single-row billing_period (no user_id column) to multi-account schema.
  try {
    const tableInfo = db.exec("PRAGMA table_info('billing_period')");
    if (tableInfo.length && tableInfo[0].values.length) {
      const columns = tableInfo[0].values.map((value: Array<unknown>) => String(value[1]));
      if (!columns.includes('user_id')) {
        const oldRow = db.exec(
          `SELECT fetched_at, source, raw_json, billing_cycle_start, billing_cycle_end,
                  membership_type, total_spend_cents, included_spend_cents, bonus_spend_cents,
                  limit_cents, remaining_cents, auto_percent, api_percent, total_percent,
                  display_message, plan_message, api_message
           FROM billing_period WHERE id = 1`
        );
        const oldValues = (
          oldRow.length && oldRow[0].values.length ? oldRow[0].values[0] : null
        ) as import('sql.js').SqlValue[] | null;

        db.run('DROP TABLE billing_period');
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
          const statement = db.prepare(
            `INSERT INTO billing_period (
              user_id, fetched_at, source, raw_json, billing_cycle_start, billing_cycle_end,
              membership_type, total_spend_cents, included_spend_cents, bonus_spend_cents,
              limit_cents, remaining_cents, auto_percent, api_percent, total_percent,
              display_message, plan_message, api_message
            ) VALUES ('',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          );
          statement.bind(oldValues);
          statement.step();
          statement.free();
        }
      }
    }
  } catch {
    // migration is best-effort
  }

  db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_period_user_cycle
     ON billing_period(user_id, billing_cycle_start)`
  );

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
  db.run(`CREATE INDEX IF NOT EXISTS idx_usage_events_timestamp ON usage_events(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_usage_events_model ON usage_events(model)`);

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

export function getTotalEventCount(): number {
  const database = getDb();
  const result = database.exec('SELECT COUNT(*) as c FROM usage_events');
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

function mapBillingRow(values: import('sql.js').SqlValue[]): BillingPeriodRow {
  return {
    userId: String(values[0] ?? ''),
    fetchedAt: values[1] as number,
    source: String(values[2] ?? ''),
    rawJson: String(values[3] ?? ''),
    billingCycleStart: (values[4] as number) ?? null,
    billingCycleEnd: (values[5] as number) ?? null,
    membershipType: (values[6] as string) ?? null,
    totalSpendCents: (values[7] as number) ?? null,
    includedSpendCents: (values[8] as number) ?? null,
    bonusSpendCents: (values[9] as number) ?? null,
    limitCents: (values[10] as number) ?? null,
    remainingCents: (values[11] as number) ?? null,
    autoPercent: (values[12] as number) ?? null,
    apiPercent: (values[13] as number) ?? null,
    totalPercent: (values[14] as number) ?? null,
    displayMessage: (values[15] as string) ?? null,
    planMessage: (values[16] as string) ?? null,
    apiMessage: (values[17] as string) ?? null
  };
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

/** Most recent billing period (any account). */
export function getLatestBillingPeriod(): BillingPeriodRow | null {
  const database = getDb();
  const result = database.exec(`${BILLING_SELECT} ORDER BY fetched_at DESC LIMIT 1`);
  if (!result.length || !result[0].values.length) {
    return null;
  }
  return mapBillingRow(result[0].values[0]);
}

/** Billing period for a specific user and cycle, or null if not cached. */
export function getBillingPeriod(userId: string, cycleStart: number): BillingPeriodRow | null {
  const database = getDb();
  const statement = database.prepare(
    `${BILLING_SELECT} WHERE user_id = ? AND billing_cycle_start = ?`
  );
  statement.bind([userId, cycleStart]);
  let row: BillingPeriodRow | null = null;
  if (statement.step()) {
    row = mapBillingRow(statement.get());
  }
  statement.free();
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

/** Insert-only merge by event_key (never deletes; multi-account safe). */
export function mergeUsageEvents(rows: UsageEventRow[]): number {
  if (rows.length === 0) {
    return 0;
  }
  const database = getDb();
  let inserted = 0;
  database.run('BEGIN');
  try {
    const existsStatement = database.prepare(
      'SELECT 1 FROM usage_events WHERE event_key = ? LIMIT 1'
    );
    const insertStatement = database.prepare(
      `INSERT OR IGNORE INTO usage_events (
        event_key, timestamp, model, kind, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, total_cents, charged_cents,
        requests_costs, conversation_id, raw_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );

    for (const row of rows) {
      existsStatement.bind([row.eventKey]);
      const alreadyExists = existsStatement.step();
      existsStatement.reset();
      if (alreadyExists) {
        continue;
      }
      insertStatement.bind([
        row.eventKey,
        row.timestamp,
        row.model,
        row.kind,
        row.inputTokens,
        row.outputTokens,
        row.cacheReadTokens,
        row.cacheWriteTokens,
        row.totalCents,
        row.chargedCents,
        row.requestsCosts,
        row.conversationId,
        row.rawJson
      ]);
      insertStatement.step();
      insertStatement.reset();
      inserted += 1;
    }

    existsStatement.free();
    insertStatement.free();
    database.run('COMMIT');
  } catch (error) {
    database.run('ROLLBACK');
    throw error;
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
  byKind: Array<{
    kind: string;
    count: number;
  }>;
  recent: UsageEventRow[];
}

export function getUsageEventStats(
  limit = 20,
  rangeStart?: number,
  rangeEnd?: number
): UsageEventStats {
  const database = getDb();
  const hasRange = rangeStart != null && rangeEnd != null;
  const whereClause = hasRange
    ? `WHERE timestamp >= ${rangeStart} AND timestamp <= ${rangeEnd}`
    : '';

  const countRow = database.exec(
    `SELECT COUNT(*),
            COALESCE(SUM(input_tokens),0),
            COALESCE(SUM(output_tokens),0),
            COALESCE(SUM(cache_read_tokens),0),
            COALESCE(SUM(cache_write_tokens),0),
            COALESCE(SUM(charged_cents),0)
     FROM usage_events ${whereClause}`
  );
  const totals = countRow[0]?.values?.[0] || [0, 0, 0, 0, 0, 0];

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

  const byKindRows = database.exec(
    `SELECT COALESCE(NULLIF(TRIM(kind), ''), 'unknown') AS kind_label, COUNT(*)
     FROM usage_events ${whereClause}
     GROUP BY kind_label
     ORDER BY COUNT(*) DESC
     LIMIT 12`
  );
  const byKind =
    byKindRows[0]?.values?.map((row) => ({
      kind: String(row[0] ?? 'unknown'),
      count: row[1] as number
    })) || [];

  const recentRows = database.exec(
    `SELECT event_key, timestamp, model, kind, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, total_cents, charged_cents,
            requests_costs, conversation_id, raw_json
     FROM usage_events ${whereClause}
     ORDER BY timestamp DESC
     LIMIT ${Math.max(1, Math.min(limit, 500))}`
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
    count: totals[0] as number,
    inputTokens: totals[1] as number,
    outputTokens: totals[2] as number,
    cacheReadTokens: totals[3] as number,
    cacheWriteTokens: totals[4] as number,
    chargedCents: totals[5] as number,
    byModel,
    byKind,
    recent
  };
}

export function exportUsageEventsCsv(rangeStart?: number, rangeEnd?: number): string {
  const database = getDb();
  const hasRange = rangeStart != null && rangeEnd != null;
  const whereClause = hasRange
    ? `WHERE timestamp >= ${rangeStart} AND timestamp <= ${rangeEnd}`
    : '';
  const result = database.exec(
    `SELECT timestamp, model, kind, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, total_cents, charged_cents,
            requests_costs, conversation_id, event_key
     FROM usage_events ${whereClause}
     ORDER BY timestamp ASC`
  );

  const header =
    'timestamp,datetime,model,kind,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_cents,charged_cents,requests_costs,conversation_id,event_key';
  const lines = [header];
  const rows = result[0]?.values || [];
  for (const row of rows) {
    const timestamp = row[0] as number;
    const datetime = new Date(timestamp).toISOString();
    const escapeCell = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    lines.push(
      [
        timestamp,
        datetime,
        escapeCell(row[1]),
        escapeCell(row[2]),
        row[3] ?? '',
        row[4] ?? '',
        row[5] ?? '',
        row[6] ?? '',
        row[7] ?? '',
        row[8] ?? '',
        row[9] ?? '',
        escapeCell(row[10]),
        escapeCell(row[11])
      ].join(',')
    );
  }
  return lines.join('\n') + '\n';
}
