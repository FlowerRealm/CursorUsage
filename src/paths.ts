import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** Local data directory for SQLite + token export. */
export const DATA_DIR = path.join(os.homedir(), '.cursor-usage-tracker');

export const DB_FILE = path.join(DATA_DIR, 'usage.db');

/** Full tokenUsage dump written by billing sync (not a capture log). */
export const TOKENS_LOG_FILE = path.join(DATA_DIR, 'usage-tokens.jsonl');

export function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
