import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, resolve, sep } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 5500);
const types = { '.html':'text/html; charset=utf-8', '.css':'text/css', '.js':'application/javascript', '.mjs':'application/javascript', '.json':'application/json', '.png':'image/png' };
createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(root + sep) || pathname.split('/').some(part => part.startsWith('.')) || pathname.startsWith('/node_modules/')) {
      response.writeHead(403).end(); return;
    }
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type':types[extname(file)] || 'application/octet-stream', 'Cache-Control':'no-store' });
    response.end(body);
  } catch { response.writeHead(404).end('Not found'); }
}).listen(port, '127.0.0.1', () => {
  console.log(`DaySync frontend: http://localhost:${port} / http://127.0.0.1:${port}`);
});
