import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  createProtocolMessage,
  isBsyncWsServerMessage,
  type BsyncWsClientMessage,
  type BsyncWsServerMessage,
} from '@bsync/sync-protocol';
import {
  ConnectionManager,
  type ConnectionSocket,
} from '../../extension/lib/connection/connection-manager';

const port = 30_000 + Math.floor(Math.random() * 10_000);
let serverProcess: Bun.Subprocess;

beforeAll(async () => {
  serverProcess = Bun.spawn(['bun', 'src/index.ts'], {
    cwd: new URL('../', import.meta.url).pathname,
    env: { ...process.env, PORT: String(port) },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  const probe = await openSocket();
  probe.close();
});

afterAll(() => {
  serverProcess?.kill();
});

test('creates and joins a room over the protocol v2 websocket boundary', async () => {
  const host = await openSocket();
  const createdMessage = waitForMessage(host, 'room:created');
  host.send(
    JSON.stringify(
      createProtocolMessage('room:create', {
        displayName: 'Host',
        targetPage: {
          title: 'Fixture',
          url: 'https://example.com/watch',
          normalizedUrl: 'https://example.com/watch',
          hostname: 'example.com',
          createdAt: 1,
        },
      }),
    ),
  );
  const created = await createdMessage;
  if (created.type !== 'room:created') throw new Error('Expected room:created');

  const guest = await openSocket();
  const joinedMessage = waitForMessage(guest, 'room:joined');
  guest.send(
    JSON.stringify(
      createProtocolMessage('room:join', {
        roomId: created.payload.roomId,
        inviteToken: created.payload.inviteToken,
        displayName: 'Guest',
      }),
    ),
  );

  await expect(joinedMessage).resolves.toMatchObject({
    type: 'room:joined',
    payload: { snapshot: { role: 'guest', peerCount: 2 } },
  });
  host.close();
  guest.close();
});

test('resumes a disconnected guest with the authoritative snapshot and no duplicate peer', async () => {
  const host = await openSocket();
  const createdMessage = waitForMessage(host, 'room:created');
  host.send(JSON.stringify(createProtocolMessage('room:create', {
    displayName: 'Host',
    targetPage: {
      title: 'Fixture',
      url: 'https://example.com/watch',
      normalizedUrl: 'https://example.com/watch',
      hostname: 'example.com',
      createdAt: 1,
    },
  })));
  const created = await createdMessage;
  if (created.type !== 'room:created') throw new Error('Expected room:created');

  const guest = await openSocket();
  const joinedMessage = waitForMessage(guest, 'room:joined');
  guest.send(JSON.stringify(createProtocolMessage('room:join', {
    roomId: created.payload.roomId,
    inviteToken: created.payload.inviteToken,
    displayName: 'Guest',
  })));
  const joined = await joinedMessage;
  if (joined.type !== 'room:joined') throw new Error('Expected room:joined');

  const mediaMessage = waitForMessage(guest, 'media:command');
  host.send(JSON.stringify(createProtocolMessage('media:snapshot', {
    media: {
      mediaKey: 'video-1',
      url: 'https://example.com/watch',
      paused: true,
      currentTime: 12,
      duration: 60,
      playbackRate: 1,
      updatedAt: Date.now(),
    },
  })));
  const media = await mediaMessage;
  if (media.type !== 'media:command') throw new Error('Expected media:command');

  guest.close();
  await Bun.sleep(25);
  const resumedGuest = await openSocket();
  const resumedMessage = waitForMessage(resumedGuest, 'room:joined');
  resumedGuest.send(JSON.stringify(createProtocolMessage('room:resume', {
    roomId: created.payload.roomId,
    resumeToken: joined.payload.resumeToken,
    lastSeq: media.payload.seq,
  })));

  await expect(resumedMessage).resolves.toMatchObject({
    type: 'room:joined',
    payload: {
      snapshot: {
        role: 'guest',
        peerCount: 2,
        media: { mediaKey: 'video-1', currentTime: 12 },
      },
    },
  });
  host.close();
  resumedGuest.close();
});

test('manager resumes through a deterministic 10-second transport outage', async () => {
  const clock = new IntegrationClock();
  let outageUntil = -1;
  const activeSocket: { current: WebSocket | null } = { current: null };
  let roomId = '';
  let resumeToken = '';
  let lastSeq = 0;
  let createdResolve!: () => void;
  let resumedResolve!: (snapshot: Extract<BsyncWsServerMessage, { type: 'room:joined' }>) => void;
  let closedResolve!: () => void;
  const createdPromise = withTimeout(new Promise<void>((resolve) => { createdResolve = resolve; }));
  const resumedPromise = withTimeout(new Promise<Extract<BsyncWsServerMessage, { type: 'room:joined' }>>(
    (resolve) => { resumedResolve = resolve; },
  ), 15_000);
  const closedPromise = withTimeout(new Promise<void>((resolve) => { closedResolve = resolve; }));

  const manager = new ConnectionManager<BsyncWsServerMessage, BsyncWsClientMessage, number>({
    createSocket: (url) => {
      if (clock.now < outageUntil) return new UnavailableSocket(clock);
      activeSocket.current = new WebSocket(url);
      return activeSocket.current;
    },
    parseMessage: (raw) => {
      const message: unknown = JSON.parse(String(raw));
      return isBsyncWsServerMessage(message) ? message : null;
    },
    onMessage: (message) => {
      if (message.type === 'room:created') {
        roomId = message.payload.roomId;
        resumeToken = message.payload.resumeToken;
        lastSeq = message.payload.snapshot.seq;
        createdResolve();
      } else if (message.type === 'room:joined') {
        resumedResolve(message);
      }
    },
    createHeartbeat: (now) => createProtocolMessage('ping', { pingSentAt: now }),
    getReconnectDelayMs: (attempt) => [500, 1_000, 2_000, 4_000, 8_000, 15_000][Math.min(attempt, 5)],
    onOpen: () => {
      manager.send(
        roomId
          ? createProtocolMessage('room:resume', { roomId, resumeToken, lastSeq })
          : createProtocolMessage('room:create', { displayName: 'Managed host', targetPage: null }),
      );
    },
    onClose: () => closedResolve(),
    now: () => clock.now,
    scheduler: clock.scheduler,
  });

  manager.connect(`ws://127.0.0.1:${port}`);
  await createdPromise;
  outageUntil = clock.now + 10_000;
  activeSocket.current?.close();
  await closedPromise;
  await Bun.sleep(10_000);

  clock.advance(10_000);
  expect(clock.now).toBe(10_000);
  expect(manager.connected).toBe(false);
  clock.advance(5_500);

  const resumed = await resumedPromise;
  expect(resumed.payload).toMatchObject({
    roomId,
    snapshot: { role: 'host', peerCount: 1, hostConnected: true },
  });
  manager.disconnect();
}, 20_000);

async function openSocket(): Promise<WebSocket> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return await new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}`);
        socket.addEventListener('open', () => resolve(socket), { once: true });
        socket.addEventListener('error', () => reject(new Error('WebSocket unavailable')), {
          once: true,
        });
      });
    } catch (error) {
      lastError = error;
      await Bun.sleep(25);
    }
  }
  throw lastError ?? new Error('Server did not start');
}

function waitForMessage<TType extends BsyncWsServerMessage['type']>(
  socket: WebSocket,
  type: TType,
): Promise<Extract<BsyncWsServerMessage, { type: TType }>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 2_000);
    const listener = (event: MessageEvent) => {
      const message: unknown = JSON.parse(String(event.data));
      if (!isBsyncWsServerMessage(message) || message.type !== type) return;
      clearTimeout(timeout);
      socket.removeEventListener('message', listener);
      resolve(message as Extract<BsyncWsServerMessage, { type: TType }>);
    };
    socket.addEventListener('message', listener);
  });
}

class IntegrationClock {
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

class UnavailableSocket implements ConnectionSocket {
  readyState = 0;
  private listeners = new Map<string, Array<(event: { data: unknown }) => void>>();

  constructor(clock: IntegrationClock) {
    clock.scheduler.setTimeout(() => this.close(), 0);
  }

  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'error', listener: () => void): void;
  addEventListener(type: 'close', listener: () => void): void;
  addEventListener(
    type: string,
    listener: (() => void) | ((event: { data: unknown }) => void),
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(): void {}

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    for (const listener of this.listeners.get('close') ?? []) listener({ data: null });
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error('Timed out waiting for manager integration event')), timeoutMs);
    }),
  ]);
}
