import { describe, expect, test } from 'bun:test';
import {
  createProtocolMessage,
  type BsyncWsServerMessage,
  type RoomTargetPage,
} from '@bsync/sync-protocol';
import { RoomManager } from './room-manager';

const targetPage: RoomTargetPage = {
  title: 'Fixture',
  url: 'https://example.com/watch',
  normalizedUrl: 'https://example.com/watch',
  hostname: 'example.com',
  createdAt: 1,
};

function createHarness(limits: { maxRooms?: number; maxSessionsPerRoom?: number } = {}) {
  const messages = new Map<string, BsyncWsServerMessage[]>();
  const scheduled: Array<() => void> = [];
  const closedPeers: string[] = [];
  const ids = ['ROOM01', 'HOST01', 'GUEST1', 'GUEST2'];
  const tokens = [
    'host_resume_token_0001',
    'room_invite_token_0001',
    'guest_resume_token_001',
    'guest_resume_token_002',
  ];
  let now = 1_000;
  const manager = new RoomManager<string>({
    send(peer, message) {
      messages.set(peer, [...(messages.get(peer) ?? []), message]);
    },
    closePeer(peer) {
      closedPeers.push(peer);
    },
    now: () => now,
    createId: () => ids.shift() ?? 'CLIENT9',
    createToken: () => tokens.shift() ?? 'fallback_token_000000',
    schedule(callback) {
      scheduled.push(callback);
      return scheduled.length as unknown as ReturnType<typeof setTimeout>;
    },
    cancelSchedule() {},
    ...limits,
  });

  return {
    manager,
    messages,
    scheduled,
    closedPeers,
    setNow(value: number) {
      now = value;
    },
    last(peer: string) {
      return messages.get(peer)?.at(-1);
    },
  };
}

function createRoom(harness: ReturnType<typeof createHarness>) {
  harness.manager.receive(
    'host',
    createProtocolMessage('room:create', { displayName: 'Host', targetPage }),
  );
  const created = harness.last('host');
  if (created?.type !== 'room:created') throw new Error('Room was not created');
  return created.payload;
}

describe('server-authoritative room lifecycle', () => {
  test('enforces room and participant capacity limits', () => {
    const roomLimited = createHarness({ maxRooms: 1 });
    createRoom(roomLimited);
    roomLimited.manager.receive(
      'host-2',
      createProtocolMessage('room:create', { displayName: 'Host 2', targetPage }),
    );
    expect(roomLimited.last('host-2')).toMatchObject({
      type: 'error',
      payload: { code: 'rate-limited' },
    });

    const participantLimited = createHarness({ maxSessionsPerRoom: 2 });
    const created = createRoom(participantLimited);
    participantLimited.manager.receive('guest', createProtocolMessage('room:join', {
      roomId: created.roomId,
      inviteToken: created.inviteToken,
      displayName: 'Guest',
    }));
    participantLimited.manager.receive('guest-2', createProtocolMessage('room:join', {
      roomId: created.roomId,
      inviteToken: created.inviteToken,
      displayName: 'Guest 2',
    }));
    expect(participantLimited.last('guest-2')).toMatchObject({
      type: 'error',
      payload: { code: 'rate-limited' },
    });
  });
  test('creates room credentials and joins only with the invite token', () => {
    const harness = createHarness();
    const created = createRoom(harness);

    expect(created.roomId).toBe('ROOM01');
    expect(created.snapshot.role).toBe('host');
    expect(created.snapshot.peerCount).toBe(1);

    harness.manager.receive(
      'attacker',
      createProtocolMessage('room:join', {
        roomId: created.roomId,
        inviteToken: 'incorrect_token_0000',
        displayName: 'Attacker',
      }),
    );
    expect(harness.last('attacker')).toMatchObject({
      type: 'error',
      payload: { code: 'invalid-invite' },
    });

    harness.manager.receive(
      'guest',
      createProtocolMessage('room:join', {
        roomId: created.roomId,
        inviteToken: created.inviteToken,
        displayName: 'Guest',
      }),
    );
    expect(harness.last('guest')).toMatchObject({
      type: 'room:joined',
      payload: { snapshot: { role: 'guest', peerCount: 2 } },
    });
  });

  test('does not let a guest publish host state', () => {
    const harness = createHarness();
    const created = createRoom(harness);
    harness.manager.receive(
      'guest',
      createProtocolMessage('room:join', {
        roomId: created.roomId,
        inviteToken: created.inviteToken,
        displayName: 'Guest',
      }),
    );

    harness.manager.receive(
      'guest',
      createProtocolMessage('room:focus', { targetPage }),
    );
    expect(harness.last('guest')).toMatchObject({
      type: 'error',
      payload: { code: 'forbidden' },
    });
  });

  test('rejects an expired server-authoritative invite', () => {
    const harness = createHarness();
    const created = createRoom(harness);
    harness.setNow(created.inviteExpiresAt);
    harness.manager.receive(
      'guest',
      createProtocolMessage('room:join', {
        roomId: created.roomId,
        inviteToken: created.inviteToken,
        displayName: 'Guest',
      }),
    );
    expect(harness.last('guest')).toMatchObject({
      type: 'error',
      payload: { code: 'invalid-invite', message: 'Invite has expired' },
    });
  });

  test('resumes host within grace and returns an authoritative snapshot', () => {
    const harness = createHarness();
    const created = createRoom(harness);
    harness.manager.disconnect('host');

    expect(harness.manager.roomCount).toBe(1);
    expect(harness.scheduled).toHaveLength(1);

    harness.manager.receive(
      'host-resumed',
      createProtocolMessage('room:resume', {
        roomId: created.roomId,
        resumeToken: created.resumeToken,
        lastSeq: created.snapshot.seq,
      }),
    );
    expect(harness.last('host-resumed')).toMatchObject({
      type: 'room:joined',
      payload: {
        snapshot: { role: 'host', hostConnected: true },
      },
    });

    harness.scheduled[0]?.();
    expect(harness.manager.roomCount).toBe(1);
  });

  test('closes room after host reconnect grace expires', () => {
    const harness = createHarness();
    createRoom(harness);
    harness.manager.disconnect('host');
    harness.scheduled[0]?.();
    expect(harness.manager.roomCount).toBe(0);
  });

  test('expires disconnected guest resume sessions', () => {
    const harness = createHarness();
    const created = createRoom(harness);
    harness.manager.receive(
      'guest',
      createProtocolMessage('room:join', {
        roomId: created.roomId,
        inviteToken: created.inviteToken,
        displayName: 'Guest',
      }),
    );
    const joined = harness.last('guest');
    if (joined?.type !== 'room:joined') throw new Error('Guest was not joined');

    harness.manager.disconnect('guest');
    harness.scheduled[0]?.();
    harness.manager.receive(
      'guest-resumed',
      createProtocolMessage('room:resume', {
        roomId: created.roomId,
        resumeToken: joined.payload.resumeToken,
        lastSeq: joined.payload.snapshot.seq,
      }),
    );
    expect(harness.last('guest-resumed')).toMatchObject({
      type: 'error',
      payload: { code: 'invalid-resume' },
    });
  });

  test('guest resumes with the latest authoritative snapshot', () => {
    const harness = createHarness();
    const created = createRoom(harness);
    harness.manager.receive(
      'guest',
      createProtocolMessage('room:join', {
        roomId: created.roomId,
        inviteToken: created.inviteToken,
        displayName: 'Guest',
      }),
    );
    const joined = harness.last('guest');
    if (joined?.type !== 'room:joined') throw new Error('Guest was not joined');
    harness.manager.disconnect('guest');

    harness.manager.receive(
      'host',
      createProtocolMessage('room:focus', {
        targetPage: { ...targetPage, url: 'https://example.com/next', normalizedUrl: 'https://example.com/next' },
      }),
    );
    harness.manager.receive(
      'guest-resumed',
      createProtocolMessage('room:resume', {
        roomId: created.roomId,
        resumeToken: joined.payload.resumeToken,
        lastSeq: joined.payload.snapshot.seq,
      }),
    );

    expect(harness.last('guest-resumed')).toMatchObject({
      type: 'room:joined',
      payload: {
        snapshot: {
          role: 'guest',
          targetPage: { url: 'https://example.com/next' },
        },
      },
    });
  });

  test('fences the previous socket when a live session is resumed elsewhere', () => {
    const harness = createHarness();
    const created = createRoom(harness);
    harness.manager.receive(
      'host-replacement',
      createProtocolMessage('room:resume', {
        roomId: created.roomId,
        resumeToken: created.resumeToken,
        lastSeq: created.snapshot.seq,
      }),
    );
    expect(harness.closedPeers).toEqual(['host']);

    harness.manager.receive(
      'host',
      createProtocolMessage('room:focus', { targetPage }),
    );
    expect(harness.last('host')).toMatchObject({
      type: 'error',
      payload: { code: 'not-joined' },
    });
  });

  test('sequences media snapshots and compensates playback age', () => {
    const harness = createHarness();
    const created = createRoom(harness);
    harness.manager.receive(
      'guest',
      createProtocolMessage('room:join', {
        roomId: created.roomId,
        inviteToken: created.inviteToken,
        displayName: 'Guest',
      }),
    );
    harness.manager.receive(
      'host',
      createProtocolMessage('media:snapshot', {
        media: {
          mediaKey: 'video-1',
          url: targetPage.url,
          paused: false,
          currentTime: 10,
          duration: 60,
          playbackRate: 1,
          updatedAt: 1_000,
        },
      }),
    );
    const mediaMessage = harness.last('guest');
    expect(mediaMessage).toMatchObject({
      type: 'media:command',
      payload: { media: { currentTime: 10, seq: 3 } },
    });

    harness.manager.receive(
      'guest-2',
      createProtocolMessage('room:join', {
        roomId: created.roomId,
        inviteToken: created.inviteToken,
        displayName: 'Guest 2',
      }),
    );

    harness.setNow(3_000);
    harness.manager.receive('guest', createProtocolMessage('media:request-snapshot', {}));
    expect(harness.last('guest')).toMatchObject({
      type: 'media:snapshot',
      payload: { media: { currentTime: 12, seq: 4 }, seq: 4 },
    });

    harness.manager.receive(
      'host',
      createProtocolMessage('media:snapshot', { media: null }),
    );
    expect(harness.last('guest')).toMatchObject({
      type: 'media:command',
      payload: { media: null, seq: 5 },
    });
  });
});
