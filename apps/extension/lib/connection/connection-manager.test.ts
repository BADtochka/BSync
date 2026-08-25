// @ts-expect-error Bun's test runner provides this module; extension builds do not include Bun types.
import { describe, expect, test } from 'bun:test';
import { ConnectionManager, type ConnectionSocket } from './connection-manager';

type Listener = (event: { data: unknown }) => void;

class FakeClock {
  now = 0;
  private nextId = 1;
  private tasks = new Map<number, { at: number; callback: () => void }>();

  readonly scheduler = {
    setTimeout: (callback: () => void, delayMs: number) => {
      const id = this.nextId++;
      this.tasks.set(id, { at: this.now + delayMs, callback });
      return id;
    },
    clearTimeout: (id: number) => this.tasks.delete(id),
  };

  advance(ms: number): void {
    const end = this.now + ms;
    while (true) {
      const next = [...this.tasks].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next || next[1].at > end) break;
      this.now = next[1].at;
      this.tasks.delete(next[0]);
      next[1].callback();
    }
    this.now = end;
  }
}

class FakeSocket implements ConnectionSocket {
  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', { data: null });
  }

  message(data: unknown): void {
    this.emit('message', { data });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', { data: null });
  }

  private emit(type: string, event: { data: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const flush = () => Promise.resolve().then(() => Promise.resolve());

describe('ConnectionManager', () => {
  test('delivers only validated messages in arrival order', async () => {
    const clock = new FakeClock();
    const socket = new FakeSocket();
    const delivered: number[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const manager = new ConnectionManager<number, object, number>({
      createSocket: () => socket,
      parseMessage: (raw) => typeof raw === 'number' ? raw : null,
      onMessage: async (message) => {
        if (message === 1) await firstBlocked;
        delivered.push(message);
      },
      createHeartbeat: (now) => ({ now }),
      getReconnectDelayMs: () => 500,
      now: () => clock.now,
      scheduler: clock.scheduler,
    });

    manager.connect('ws://relay');
    socket.open();
    socket.message(1);
    socket.message('invalid');
    socket.message(2);
    await flush();
    expect(delivered).toEqual([]);
    releaseFirst();
    await flush();
    expect(delivered).toEqual([1, 2]);
  });

  test('owns connect timeout, heartbeat, stale detection, and reconnect timers', () => {
    const clock = new FakeClock();
    const sockets: FakeSocket[] = [];
    const closes: string[] = [];
    const manager = new ConnectionManager<number, object, number>({
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      parseMessage: (raw) => typeof raw === 'number' ? raw : null,
      onMessage: () => undefined,
      createHeartbeat: (now) => ({ now }),
      getReconnectDelayMs: () => 500,
      onClose: ({ reason }) => closes.push(reason),
      now: () => clock.now,
      scheduler: clock.scheduler,
      connectTimeoutMs: 1_000,
      heartbeatIntervalMs: 100,
      staleAfterMs: 250,
    });

    manager.connect('ws://relay');
    clock.advance(1_000);
    expect(closes).toEqual(['connect-timeout']);
    clock.advance(500);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    clock.advance(100);
    expect(sockets[1].sent).toEqual(['{"now":1600}']);
    clock.advance(200);
    expect(closes).toEqual(['connect-timeout', 'stale']);
  });

  test('resets backoff only after valid traffic survives the stable window', async () => {
    const clock = new FakeClock();
    const sockets: FakeSocket[] = [];
    let stableCount = 0;
    const manager = new ConnectionManager<number, object, number>({
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      parseMessage: (raw) => typeof raw === 'number' ? raw : null,
      onMessage: () => undefined,
      createHeartbeat: () => ({}),
      getReconnectDelayMs: (attempt) => (attempt + 1) * 100,
      onStable: () => { stableCount += 1; },
      now: () => clock.now,
      scheduler: clock.scheduler,
      stableTrafficWindowMs: 1_000,
    });

    manager.connect('ws://relay');
    sockets[0].close();
    expect(manager.attempt).toBe(1);
    clock.advance(100);
    sockets[1].open();
    sockets[1].message('invalid');
    clock.advance(1_000);
    expect(manager.attempt).toBe(1);
    sockets[1].message(1);
    await flush();
    clock.advance(999);
    expect(manager.attempt).toBe(1);
    clock.advance(1);
    expect(manager.attempt).toBe(0);
    expect(stableCount).toBe(1);
  });

  test('disconnect cancels transport timers without touching external timers', () => {
    const clock = new FakeClock();
    const socket = new FakeSocket();
    let externalFired = false;
    clock.scheduler.setTimeout(() => { externalFired = true; }, 50);
    const manager = new ConnectionManager<number, object, number>({
      createSocket: () => socket,
      parseMessage: () => null,
      onMessage: () => undefined,
      createHeartbeat: () => ({}),
      getReconnectDelayMs: () => 10,
      now: () => clock.now,
      scheduler: clock.scheduler,
    });
    manager.connect('ws://relay');
    manager.disconnect();
    clock.advance(50);
    expect(externalFired).toBe(true);
  });
});
