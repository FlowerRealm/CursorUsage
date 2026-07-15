import * as fs from 'fs';
import { IMPORT_OFFSET_FILE, LOG_FILE, ensureDataDir } from '../patcher';
import { RawLogEntry, parseLogEntry } from './classifier';
import { insertRequests } from './database';

function readOffset(): number {
  try {
    if (fs.existsSync(IMPORT_OFFSET_FILE)) {
      return parseInt(fs.readFileSync(IMPORT_OFFSET_FILE, 'utf8').trim(), 10) || 0;
    }
  } catch {
    // ignore
  }
  return 0;
}

function writeOffset(offset: number): void {
  ensureDataDir();
  fs.writeFileSync(IMPORT_OFFSET_FILE, String(offset));
}

/**
 * Incrementally import new JSONL lines into SQLite.
 * Tracks byte offset so re-imports skip already-processed data.
 */
export function importNewEntries(): { imported: number; offset: number } {
  if (!fs.existsSync(LOG_FILE)) {
    return { imported: 0, offset: 0 };
  }

  const stats = fs.statSync(LOG_FILE);
  let offset = readOffset();

  // Log was rotated/truncated
  if (offset > stats.size) {
    offset = 0;
  }

  if (offset >= stats.size) {
    return { imported: 0, offset };
  }

  const fd = fs.openSync(LOG_FILE, 'r');
  try {
    const length = stats.size - offset;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, offset);
    const text = buf.toString('utf8');

    // Keep incomplete last line for next import
    let processText = text;
    let newOffset = stats.size;
    if (!text.endsWith('\n')) {
      const lastNl = text.lastIndexOf('\n');
      if (lastNl === -1) {
        // Entire chunk is incomplete line
        return { imported: 0, offset };
      }
      processText = text.slice(0, lastNl + 1);
      newOffset = offset + Buffer.byteLength(processText, 'utf8');
    }

    const lines = processText.split('\n').filter((l) => l.trim());
    const records = [];
    for (const line of lines) {
      try {
        const raw = JSON.parse(line) as RawLogEntry;
        const parsed = parseLogEntry(raw);
        if (parsed) {
          records.push(parsed);
        }
      } catch {
        // skip bad lines
      }
    }

    const imported = insertRequests(records);
    writeOffset(newOffset);
    return { imported, offset: newOffset };
  } finally {
    fs.closeSync(fd);
  }
}
