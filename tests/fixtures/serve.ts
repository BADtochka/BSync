import { resolve } from 'node:path';

const ports = process.argv[2] == null ? [4173, 4174] : [Number(process.argv[2])];
if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
  throw new Error('Usage: bun tests/fixtures/serve.ts [port]');
}

const fixtureRoot = import.meta.dir;
const allowedFiles = new Set([
  'direct-video.html',
  'iframe-host.html',
  'iframe-player.html',
  'multiple-media.html',
  'replaced-iframe.html',
  'spa-player.html',
]);

for (const port of ports) {
  Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const fileName = path === '/' ? 'iframe-host.html' : path.slice(1);
      if (!allowedFiles.has(fileName)) return new Response('Not found', { status: 404 });
      return new Response(Bun.file(resolve(fixtureRoot, fileName)), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    },
  });

  console.log(`BSync fixtures: http://127.0.0.1:${port}`);
}
