import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface CursorCredentials {
  accessToken: string;
  refreshToken?: string;
  email?: string;
  membershipType?: string;
  subscriptionStatus?: string;
  /** WorkOS-style user id, e.g. user_01... */
  userId: string;
  /** Cookie value: userId%3A%3AaccessToken */
  workosCookie: string;
}

function stateDbPath(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(config, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length < 2) {
    return {};
  }
  const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  try {
    return JSON.parse(Buffer.from(pad, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function extractUserId(accessToken: string): string {
  const payload = decodeJwtPayload(accessToken);
  const sub = String(payload.sub || '');
  const pipe = sub.includes('|') ? sub.split('|').pop() || '' : sub;
  if (pipe.startsWith('user_')) {
    return pipe;
  }
  const m = sub.match(/user_[A-Za-z0-9]+/);
  if (m) {
    return m[0];
  }
  throw new Error('Could not extract user_ id from accessToken JWT sub');
}

/**
 * Read Cursor auth from local state.vscdb. Never writes tokens to our logs.
 */
export async function loadCursorCredentials(): Promise<CursorCredentials> {
  const dbPath = stateDbPath();
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Cursor state DB not found: ${dbPath}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const initSqlJsAsm = require('sql.js/dist/sql-asm.js');
  const SQL = await initSqlJsAsm();
  const buf = fs.readFileSync(dbPath);
  const database = new SQL.Database(buf);

  const get = (key: string): string | undefined => {
    const stmt = database.prepare('SELECT value FROM ItemTable WHERE key = ?');
    stmt.bind([key]);
    let value: string | undefined;
    if (stmt.step()) {
      const row = stmt.getAsObject() as { value?: string };
      value = row.value;
    }
    stmt.free();
    return value;
  };

  try {
    const accessToken = get('cursorAuth/accessToken');
    if (!accessToken) {
      throw new Error('cursorAuth/accessToken missing — is Cursor signed in?');
    }
    const userId = extractUserId(accessToken);
    const workosCookie = `${userId}%3A%3A${accessToken}`;
    return {
      accessToken,
      refreshToken: get('cursorAuth/refreshToken'),
      email: get('cursorAuth/cachedEmail'),
      membershipType: get('cursorAuth/stripeMembershipType'),
      subscriptionStatus: get('cursorAuth/stripeSubscriptionStatus'),
      userId,
      workosCookie
    };
  } finally {
    database.close();
  }
}
