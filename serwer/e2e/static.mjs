// Prosty serwer plików frontu do testów. Opcjonalnie podmienia ROOMS_API w config.js.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../przy-szachownicy');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};

export function serveFront(port, roomsApi) {
  const server = http.createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(FRONT, p);
    if (!file.startsWith(FRONT)) { res.writeHead(403).end(); return; }
    try {
      let body = await fs.readFile(file);
      if (p === '/config.js' && roomsApi != null) {
        body = body.toString('utf8').replace(/ROOMS_API:\s*'[^']*'/, `ROOMS_API: '${roomsApi}'`);
      }
      // bez service workera w testach (świeże pliki przy każdym uruchomieniu)
      if (p === '/sw.js') { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
