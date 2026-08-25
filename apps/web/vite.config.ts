import preact from '@preact/preset-vite';
import { defineConfig, type Plugin } from 'vite';

function hashAssetList(assets: string[]): string {
  let hash = 5381;
  for (const character of assets.join('|')) hash = (hash * 33) ^ character.charCodeAt(0);
  return (hash >>> 0).toString(36);
}

function serviceWorkerPlugin(): Plugin {
  return {
    name: 'bsync-service-worker',
    generateBundle(_, bundle) {
      const scriptFiles = new Set<string>();
      const addChunk = (fileName: string): void => {
        const entry = bundle[fileName];
        if (!entry || entry.type !== 'chunk' || scriptFiles.has(fileName)) return;
        scriptFiles.add(fileName);
        for (const imported of [...entry.imports, ...entry.dynamicImports]) addChunk(imported);
      };
      for (const entry of Object.values(bundle)) {
        if (entry.type === 'chunk' && entry.moduleIds.some((id) => id.endsWith('/src/main.tsx'))) {
          addChunk(entry.fileName);
        }
      }
      const assets = [
        '/',
        '/index.html',
        '/invite/index.html',
        '/privacy/index.html',
        '/manifest.webmanifest',
        '/icons/icon-192.svg',
        '/icons/icon-512.svg',
        ...Object.values(bundle).filter((entry) => entry.type === 'asset').map((entry) => `/${entry.fileName}`),
        ...Array.from(scriptFiles, (fileName) => `/${fileName}`),
      ].filter((asset, index, all) => all.indexOf(asset) === index);
      const cacheName = `bsync-shell-${hashAssetList(assets)}`;
      const source = `const CACHE_NAME = ${JSON.stringify(cacheName)};
const SHELL_ASSETS = ${JSON.stringify(assets)};
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('bsync-shell-') && key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match(url.pathname.startsWith('/invite') ? '/invite/index.html' : url.pathname.startsWith('/privacy') ? '/privacy/index.html' : '/index.html')));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok && url.pathname !== '/invite' && !url.pathname.startsWith('/invite/')) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
    return response;
  })));
});`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  plugins: [preact(), serviceWorkerPlugin()],
  build: {
    rollupOptions: {
      input: {
        index: new URL('./index.html', import.meta.url).pathname,
        invite: new URL('./invite/index.html', import.meta.url).pathname,
        privacy: new URL('./privacy/index.html', import.meta.url).pathname,
      },
    },
  },
});
