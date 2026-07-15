const fs = require('fs');
const path = require('path');
const os = require('os');
const initSqlJs = require('sql.js/dist/sql-asm.js');

function categorize(host, urlPath) {
  const h = host.toLowerCase();
  const p = urlPath.toLowerCase();
  if (h === 'metrics.cursor.sh' || p.startsWith('/tev1/')) return 'telemetry';
  if (p.includes('/auth/') || h.includes('authentication.cursor.sh')) return 'auth';
  if (p.includes('/updates/')) return 'update';
  if (h === 'repo42.cursor.sh') return 'indexing';
  if (h.endsWith('.api5.cursor.sh') || h === 'api5.cursor.sh') return 'agent';
  if (h === 'api2.cursor.sh' && p.includes('/aiserver.v1.')) return 'chat';
  if ((h === 'api3.cursor.sh' || h === 'api4.cursor.sh') && !p.startsWith('/tev1/')) return 'tab';
  return 'other';
}

(async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(
    'CREATE TABLE requests (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER, url TEXT, host TEXT, path TEXT, method TEXT, status_code INTEGER, resource_type TEXT, category TEXT)'
  );
  const log = path.join(os.homedir(), '.cursor-usage-tracker', 'requests.jsonl');
  if (!fs.existsSync(log)) {
    console.log('no log');
    return;
  }
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  const counts = {};
  const stmt = db.prepare('INSERT INTO requests VALUES (NULL,?,?,?,?,?,?,?,?)');
  for (const line of lines) {
    const e = JSON.parse(line);
    const u = new URL(e.url);
    const cat = categorize(u.hostname, u.pathname);
    counts[cat] = (counts[cat] || 0) + 1;
    stmt.bind([e.t, e.url, u.hostname, u.pathname, e.m, e.s, e.type || 'other', cat]);
    stmt.step();
    stmt.reset();
  }
  stmt.free();
  console.log('Imported', lines.length, 'records');
  console.log('Categories', counts);
})();
