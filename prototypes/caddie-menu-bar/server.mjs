import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || process.argv[2] || 4173);
const host = process.argv[3] || process.env.HOST || '127.0.0.1';
const types = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
]);

createServer(async (request, response) => {
  const requestPath = new URL(request.url, `http://${request.headers.host}`).pathname;
  const relative = requestPath === '/' ? 'index.html' : requestPath.slice(1);
  const candidate = path.resolve(root, relative);
  if (!candidate.startsWith(`${root}${path.sep}`) && candidate !== path.join(root, 'index.html')) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  const info = await stat(candidate).catch(() => null);
  if (!info?.isFile()) {
    response.writeHead(404).end('Not found');
    return;
  }
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': types.get(path.extname(candidate)) || 'application/octet-stream',
  });
  createReadStream(candidate).pipe(response);
}).listen(port, host, () => {
  console.log(`Caddie menu bar prototype: http://${host}:${port}/?variant=A&scenario=mixed`);
});
