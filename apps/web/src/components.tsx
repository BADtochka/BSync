import type { ComponentChildren } from 'preact';
import { getBrowserPreference, normalizeStoreUrl, type BrowserPreference } from './browser';

const storeConfig = {
  chrome: {
    name: 'Chrome Web Store',
    url: normalizeStoreUrl(import.meta.env.VITE_CHROME_STORE_URL),
  },
  firefox: {
    name: 'Firefox Add-ons',
    url: normalizeStoreUrl(import.meta.env.VITE_FIREFOX_STORE_URL),
  },
} as const;

export function Layout({ children }: { children: ComponentChildren }) {
  return (
    <div class="site-shell">
      <header class="site-header">
        <a class="brand" href="/" aria-label="BSync home">
          <span class="brand-mark" aria-hidden="true">B</span>
          <span class="bsync-wordmark">BSync</span>
        </a>
        <nav class="site-nav" aria-label="Primary navigation">
          <a href="/">Home</a>
          <a href="/privacy">Privacy</a>
          <a href="https://github.com/BADtochka/BSync" rel="noreferrer">Source</a>
        </nav>
      </header>
      <main>{children}</main>
      <footer class="site-footer">
        <span class="bsync-label">BSYNC / OPEN SOURCE</span>
        <span>Browser media coordination, not media streaming.</span>
      </footer>
    </div>
  );
}

export function StoreCtas({ compact = false }: { compact?: boolean }) {
  const preference = getBrowserPreference(navigator.userAgent);
  return (
    <div class={`store-grid${compact ? ' store-grid--compact' : ''}`} aria-label="Browser extension downloads">
      <StoreCta browser="chrome" preference={preference} />
      <StoreCta browser="firefox" preference={preference} />
    </div>
  );
}

function StoreCta({ browser, preference }: { browser: keyof typeof storeConfig; preference: BrowserPreference }) {
  const store = storeConfig[browser];
  const available = store.url !== null;
  const preferred = preference === browser;
  const content = (
    <>
      <span>
        <small>{preferred ? 'Recommended for this browser' : 'Browser extension'}</small>
        {store.name}
      </span>
      <span class="store-state" data-available={available}>{available ? 'Available' : 'Coming soon'}</span>
    </>
  );

  if (!available) {
    return (
      <span class={`store-cta${preferred ? ' store-cta--preferred' : ''}`} aria-disabled="true">
        {content}
      </span>
    );
  }
  return (
    <a class={`store-cta${preferred ? ' store-cta--preferred' : ''}`} href={store.url} rel="noreferrer">
      {content}
    </a>
  );
}
