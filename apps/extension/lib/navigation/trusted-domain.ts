export function normalizeTrustedDomain(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  try {
    const withProtocol = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
    const url = new URL(withProtocol);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const hostname = url.hostname;
    if (
      !hostname ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(hostname)
    ) {
      return null;
    }
    return hostname;
  } catch {
    return null;
  }
}
