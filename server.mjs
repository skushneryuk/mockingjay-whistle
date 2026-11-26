import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(fileURLToPath(new URL('./dist/', import.meta.url)));
const index = path.join(root, 'index.html');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.wav': 'audio/wav',
};
const port = Number(process.env.PORT || 4173);

function send(res, extension, body) {
  res.writeHead(200, {
    'Content-Type': types[extension] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Permissions-Policy': 'microphone=(self)',
  });
  res.end(body);
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/_qa.html') {
      const html = (await readFile(index, 'utf8')).replace('<script type="module" src="./app.mjs"></script>', '<script type="module" src="/_qa-fixture.mjs"></script><script type="module" src="./app.mjs"></script>');
      send(res, '.html', html);
      return;
    }
    if (url.pathname === '/_qa-fixture.mjs') {
      send(res, '.mjs', await readFile(new URL('./tests/browser-fixture.mjs', import.meta.url)));
      return;
    }
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const body = await readFile(file);
    send(res, path.extname(file), body);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`Local: http://localhost:${port}`));
