// Tiny static file server for local play (`npm start`) and for the tests.
// It sends the same Content-Security-Policy that render.yaml sets in production.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export function readCsp() {
  const yaml = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');
  const match = yaml.match(/name:\s*Content-Security-Policy\s*\n\s*value:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

export function startServer(port = 0) {
  const csp = readCsp();
  const server = http.createServer((req, res) => {
    let urlPath = '/';
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch (err) {
      res.writeHead(400).end();
      return;
    }
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    const file = path.normalize(path.join(PUBLIC, urlPath));
    if (!file.startsWith(PUBLIC + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
        return;
      }
      const headers = {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      };
      if (csp) headers['Content-Security-Policy'] = csp;
      res.writeHead(200, headers).end(body);
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/` });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { url } = await startServer(Number(process.env.PORT) || 4173);
  console.log(`Spellcaster Academy is running at ${url}  (Ctrl+C to stop)`);
}
