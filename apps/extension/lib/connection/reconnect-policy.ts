export const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000] as const;
export const RECONNECT_JITTER_RATIO = 0.2;

export function getReconnectDelayMs(attempt: number, random = Math.random): number {
  const baseDelay = RECONNECT_DELAYS_MS[Math.min(Math.max(0, attempt), RECONNECT_DELAYS_MS.length - 1)];
  const jitter = (random() * 2 - 1) * RECONNECT_JITTER_RATIO;
  return Math.max(0, Math.round(baseDelay * (1 + jitter)));
}

export function shouldAcceptServerSequence(lastAcceptedSeq: number, incomingSeq: number): boolean {
  return Number.isSafeInteger(incomingSeq) && incomingSeq > lastAcceptedSeq;
}

export function shouldConnectTransport(options: {
  configurationChanged: boolean;
  reconnectScheduled: boolean;
  socketUnavailable: boolean;
  serverChanged: boolean;
  socketClosing: boolean;
}): boolean {
  if (options.configurationChanged) return true;
  if (options.reconnectScheduled) return false;
  return options.socketUnavailable || options.serverChanged || options.socketClosing;
}
