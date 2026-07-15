import { readFileSync } from 'fs';
import { createServer } from 'http';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3456;

const server = createServer((req, res) => {
  const htmlPath = resolve(__dirname, '../src/webview/dashboard.html');
  let html = readFileSync(htmlPath, 'utf8');
  html = html.replace('{{CSP}}', "default-src * 'unsafe-inline' 'unsafe-eval' data: blob: https:");
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

server.listen(PORT, () => {
  console.log(`\n  Dashboard preview → http://localhost:${PORT}\n`);
});
