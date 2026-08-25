export const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
export const DEFAULT_STALE_AFTER_MS = 30_000;
export const DEFAULT_STABLE_TRAFFIC_WINDOW_MS = 10_000;

export interface ConnectionSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'error', listener: () => void): void;
  addEventListener(type: 'close', listener: () => void): void;
}

export interface ConnectionScheduler<Timer = ReturnType<typeof setTimeout>> {
  setTimeout(callback: () => void, delayMs: number): Timer;
  clearTimeout(timer: Timer): void;
}

export type ConnectionCloseReason = 'connect-timeout' | 'stale' | 'disconnected';

export interface ConnectionManagerOptions<Message, Outbound, Timer> {
  createSocket(url: string): ConnectionSocket;
  parseMessage(raw: unknown): Message | null;
  onMessage(message: Message): void | Promise<void>;
  createHeartbeat(now: number): Outbound;
  getReconnectDelayMs(attempt: number): number;
  onConnecting?(event: { url: string; reconnecting: boolean; attempt: number }): void;
  onOpen?(event: { url: string }): void;
  onClose?(event: { reason: ConnectionCloseReason; willReconnect: boolean }): void;
  onError?(error: unknown): void;
  onReconnectScheduled?(event: { attempt: number; delayMs: number }): void;
  onStable?(): void;
  serialize?: (message: Outbound) => string;
  now?: () => number;
  scheduler?: ConnectionScheduler<Timer>;
  connectTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  staleAfterMs?: number;
  stableTrafficWindowMs?: number;
}

const OPEN = 1;
const CLOSING = 2;

export class ConnectionManager<Message, Outbound, Timer = ReturnType<typeof setTimeout>> {
  private readonly options: ConnectionManagerOptions<Message, Outbound, Timer>;
  private readonly now: () => number;
  private readonly scheduler: ConnectionScheduler<Timer>;
  private readonly serialize: (message: Outbound) => string;
  private socket: ConnectionSocket | null = null;
  private url = '';
  private enabled = false;
  private reconnectAttempt = 0;
  private reconnectTimer: Timer | null = null;
  private connectTimeoutTimer: Timer | null = null;
  private heartbeatTimer: Timer | null = null;
  private stableTimer: Timer | null = null;
  private lastValidTrafficAt = 0;
  private closeReason: ConnectionCloseReason | null = null;
  private generation = 0;
  private messageQueue: Promise<void> = Promise.resolve();

  constructor(options: ConnectionManagerOptions<Message, Outbound, Timer>) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.scheduler = options.scheduler ?? {
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs) as Timer,
      clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    };
    this.serialize = options.serialize ?? JSON.stringify;
  }

  get connected(): boolean {
    return this.socket?.readyState === OPEN;
  }

  get currentUrl(): string {
    return this.url;
  }

  get reconnectScheduled(): boolean {
    return this.reconnectTimer !== null;
  }

  get attempt(): number {
    return this.reconnectAttempt;
  }

  connect(url: string, resetBackoff = false): void {
    if (resetBackoff) this.reconnectAttempt = 0;
    this.enabled = true;
    if (this.url === url && this.socket && this.socket.readyState < CLOSING) return;
    if (this.url === url && this.reconnectTimer) return;

    this.replaceConnection(url);
  }

  disconnect(): void {
    this.enabled = false;
    this.generation += 1;
    this.clearTransportTimers();
    const socket = this.socket;
    this.socket = null;
    this.url = '';
    this.closeReason = null;
    if (socket && socket.readyState < CLOSING) socket.close();
  }

  send(message: Outbound): boolean {
    if (!this.socket || this.socket.readyState !== OPEN) return false;
    this.socket.send(this.serialize(message));
    return true;
  }

  private replaceConnection(url: string): void {
    const previous = this.socket;
    this.generation += 1;
    this.clearTransportTimers();
    this.socket = null;
    this.url = url;
    this.closeReason = null;
    if (previous && previous.readyState < CLOSING) previous.close();
    this.openSocket();
  }

  private openSocket(): void {
    if (!this.enabled || !this.url) return;
    const generation = this.generation;
    const reconnecting = this.reconnectAttempt > 0;
    this.options.onConnecting?.({
      url: this.url,
      reconnecting,
      attempt: this.reconnectAttempt,
    });

    let socket: ConnectionSocket;
    try {
      socket = this.options.createSocket(this.url);
    } catch (error) {
      this.options.onError?.(error);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    this.connectTimeoutTimer = this.scheduler.setTimeout(() => {
      if (!this.isCurrent(socket, generation) || socket.readyState !== 0) return;
      this.closeReason = 'connect-timeout';
      socket.close();
    }, this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);

    socket.addEventListener('open', () => {
      if (!this.isCurrent(socket, generation)) return;
      this.clearTimer('connectTimeoutTimer');
      this.lastValidTrafficAt = this.now();
      this.options.onOpen?.({ url: this.url });
      this.scheduleHeartbeat(socket, generation);
    });
    socket.addEventListener('message', (event) => {
      if (!this.isCurrent(socket, generation)) return;
      let message: Message | null;
      try {
        message = this.options.parseMessage(event.data);
      } catch (error) {
        this.options.onError?.(error);
        return;
      }
      if (message === null) return;
      this.recordValidTraffic(socket, generation);
      const deliver = async () => {
        if (!this.isCurrent(socket, generation)) return;
        await this.options.onMessage(message);
      };
      this.messageQueue = this.messageQueue.then(deliver, deliver);
      this.messageQueue.catch((error) => this.options.onError?.(error));
    });
    socket.addEventListener('error', () => {
      if (this.isCurrent(socket, generation)) {
        this.options.onError?.(new Error('WebSocket connection error'));
      }
    });
    socket.addEventListener('close', () => {
      if (!this.isCurrent(socket, generation)) return;
      const reason = this.closeReason ?? 'disconnected';
      this.generation += 1;
      this.clearTimer('connectTimeoutTimer');
      this.clearTimer('heartbeatTimer');
      this.clearTimer('stableTimer');
      this.socket = null;
      this.closeReason = null;
      const willReconnect = this.enabled;
      if (willReconnect) this.scheduleReconnect();
      this.options.onClose?.({ reason, willReconnect });
    });
  }

  private recordValidTraffic(socket: ConnectionSocket, generation: number): void {
    this.lastValidTrafficAt = this.now();
    if (this.stableTimer || this.reconnectAttempt === 0) return;
    this.stableTimer = this.scheduler.setTimeout(() => {
      this.stableTimer = null;
      if (!this.isCurrent(socket, generation) || socket.readyState !== OPEN) return;
      this.reconnectAttempt = 0;
      this.options.onStable?.();
    }, this.options.stableTrafficWindowMs ?? DEFAULT_STABLE_TRAFFIC_WINDOW_MS);
  }

  private scheduleHeartbeat(socket: ConnectionSocket, generation: number): void {
    this.heartbeatTimer = this.scheduler.setTimeout(() => {
      this.heartbeatTimer = null;
      if (!this.isCurrent(socket, generation) || socket.readyState !== OPEN) return;
      const now = this.now();
      if (now - this.lastValidTrafficAt >= (this.options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS)) {
        this.closeReason = 'stale';
        socket.close(4000, 'Connection stale');
        return;
      }
      this.send(this.options.createHeartbeat(now));
      this.scheduleHeartbeat(socket, generation);
    }, this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
  }

  private scheduleReconnect(): void {
    if (!this.enabled || this.reconnectTimer) return;
    const attempt = this.reconnectAttempt;
    const delayMs = this.options.getReconnectDelayMs(attempt);
    this.reconnectAttempt += 1;
    this.options.onReconnectScheduled?.({ attempt, delayMs });
    this.reconnectTimer = this.scheduler.setTimeout(() => {
      this.reconnectTimer = null;
      this.generation += 1;
      this.openSocket();
    }, delayMs);
  }

  private isCurrent(socket: ConnectionSocket, generation: number): boolean {
    return this.socket === socket && this.generation === generation;
  }

  private clearTransportTimers(): void {
    this.clearTimer('reconnectTimer');
    this.clearTimer('connectTimeoutTimer');
    this.clearTimer('heartbeatTimer');
    this.clearTimer('stableTimer');
  }

  private clearTimer(
    key: 'reconnectTimer' | 'connectTimeoutTimer' | 'heartbeatTimer' | 'stableTimer',
  ): void {
    const timer = this[key];
    if (timer !== null) this.scheduler.clearTimeout(timer);
    this[key] = null;
  }
}
