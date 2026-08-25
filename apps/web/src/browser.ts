export type BrowserPreference = 'chrome' | 'firefox' | 'none';

export function getBrowserPreference(userAgent: string): BrowserPreference {
  if (/Firefox\//iu.test(userAgent)) return 'firefox';
  if (/(?:Chrome|Chromium|CriOS|Edg|OPR)\//iu.test(userAgent)) return 'chrome';
  return 'none';
}

export function normalizeStoreUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
