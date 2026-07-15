import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** Root data directory for all persisted tracker data. */
export const DATA_DIR = path.join(os.homedir(), '.cursor-usage-tracker');

// ── Subdirectories ──────────────────────────────────────────────────────────

const DB_DIR = path.join(DATA_DIR, 'db');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const TMP_DIR = path.join(DATA_DIR, 'tmp');

// ── File paths ──────────────────────────────────────────────────────────────

/** SQLite database storing billing periods and usage events. */
export const DB_FILE = path.join(DB_DIR, 'usage.db');

/** Full tokenUsage dump written by billing sync (not a capture log). */
export const TOKENS_LOG_FILE = path.join(LOGS_DIR, 'usage-tokens.jsonl');

/** Temporary file used during atomic write of the tokens log. */
export const TOKENS_TMP_FILE = path.join(TMP_DIR, 'usage-tokens.jsonl.tmp');

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Create all required subdirectories under DATA_DIR. */
export function ensureDataDir(): void {
  fs.mkdirSync(DB_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

/**
 * One-time migration: move files that previously lived flat under DATA_DIR into
 * the new subdirectory layout. Safe to call on every startup — it only moves a
 * file when the legacy path exists and the target path does not.
 */
export function migrateLegacyFiles(): void {
  const legacyDb = path.join(DATA_DIR, 'usage.db');
  const legacyTokens = path.join(DATA_DIR, 'usage-tokens.jsonl');

  if (fs.existsSync(legacyDb) && !fs.existsSync(DB_FILE)) {
    fs.renameSync(legacyDb, DB_FILE);
  }
  if (fs.existsSync(legacyTokens) && !fs.existsSync(TOKENS_LOG_FILE)) {
    fs.renameSync(legacyTokens, TOKENS_LOG_FILE);
  }
}
