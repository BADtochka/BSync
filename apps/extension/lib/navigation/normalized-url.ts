import type { RoomTargetPage } from '@bsync/sync-protocol';

function stripUrlHash(url: string): string {
  const hashIndex = url.indexOf('#');
  return hashIndex === -1 ? url : url.slice(0, hashIndex);
}

function normalizeRoomPath(pathname: string): string {
  if (!pathname) return '/';
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function normalizeRoomQuery(query: string | undefined): string {
  if (!query) return '';
  return query
    .split('&')
    .filter(Boolean)
    .sort((left, right) => {
      const leftKey = left.split('=', 1)[0] ?? '';
      const rightKey = right.split('=', 1)[0] ?? '';
      return leftKey.localeCompare(rightKey) || left.localeCompare(right);
    })
    .join('&');
}

function normalizeRoomAuthority(authority: string): string | null {
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  if (!hostPort) return null;
  if (hostPort.startsWith('[')) {
    const closingBracketIndex = hostPort.indexOf(']');
    if (closingBracketIndex === -1) return null;
    return `${hostPort.slice(0, closingBracketIndex + 1).toLowerCase()}${hostPort.slice(
      closingBracketIndex + 1,
    )}`;
  }

  const colonIndex = hostPort.lastIndexOf(':');
  const hasPort = colonIndex > -1 && hostPort.indexOf(':') === colonIndex;
  const hostname = (hasPort ? hostPort.slice(0, colonIndex) : hostPort)
    .replace(/^www\./i, '')
    .toLowerCase();
  const port = hasPort ? hostPort.slice(colonIndex) : '';
  return hostname ? `${hostname}${port}` : null;
}

export function canonicalRoomPageUrl(url: string): string | null {
  const withoutHash = stripUrlHash(url.trim());
  const match = withoutHash.match(/^([a-z][a-z0-9+.-]*:)\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?$/i);
  if (!match) return null;

  const [, protocol, authority, rawPathname, rawQuery] = match;
  const normalizedAuthority = normalizeRoomAuthority(authority);
  if (!normalizedAuthority) return null;
  const pathname = normalizeRoomPath(rawPathname);
  const query = normalizeRoomQuery(rawQuery);
  return `${protocol.toLowerCase()}//${normalizedAuthority}${pathname}${query ? `?${query}` : ''}`;
}

export function normalizeSyncUrl(url: string): string {
  return canonicalRoomPageUrl(url) ?? stripUrlHash(url.trim());
}

export function sanitizeObservedPageUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return '';
  }
}

export function isRoomTargetUrl(
  targetPage: RoomTargetPage | null | undefined,
  url: string,
): boolean {
  if (!targetPage) return false;
  const current = new Set([normalizeSyncUrl(url), stripUrlHash(url.trim())]);
  const target = new Set([
    normalizeSyncUrl(targetPage.url),
    normalizeSyncUrl(targetPage.normalizedUrl),
    stripUrlHash(targetPage.url.trim()),
    stripUrlHash(targetPage.normalizedUrl.trim()),
  ]);
  for (const candidate of current) {
    if (target.has(candidate)) return true;
  }
  return false;
}
