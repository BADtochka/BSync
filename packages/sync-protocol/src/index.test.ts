import { describe, expect, test } from 'bun:test';
import {
  createProtocolMessage,
  isBsyncWsClientMessage,
  isBsyncWsServerMessage,
} from './index';

const page = {
  title: 'Fixture',
  url: 'https://example.com/watch',
  normalizedUrl: 'https://example.com/watch',
  hostname: 'example.com',
  createdAt: 1,
};

describe('protocol v2 validation', () => {
  test('accepts a valid create request', () => {
    expect(
      isBsyncWsClientMessage(
        createProtocolMessage('room:create', { displayName: 'Browser', targetPage: page }),
      ),
    ).toBe(true);
  });

  test('rejects legacy and malformed envelopes', () => {
    expect(isBsyncWsClientMessage({ type: 'join', sentAt: 1 })).toBe(false);
    expect(
      isBsyncWsClientMessage({
        ...createProtocolMessage('room:join', {
          roomId: 'ABC123',
          inviteToken: 'valid_invite_token_123',
          displayName: 'Browser',
        }),
        protocolVersion: 1,
      }),
    ).toBe(false);
    expect(
      isBsyncWsClientMessage({
        ...createProtocolMessage('ping', { pingSentAt: 1 }),
        unexpected: true,
      }),
    ).toBe(false);
  });

  test('rejects unknown client and server payload keys', () => {
    expect(
      isBsyncWsClientMessage(
        createProtocolMessage('room:join', {
          roomId: 'ABC123',
          inviteToken: 'valid_invite_token_123',
          displayName: 'Browser',
          unexpected: true,
        }),
      ),
    ).toBe(false);
    expect(
      isBsyncWsServerMessage(
        createProtocolMessage('room:presence', {
          roomId: 'ABC123',
          peerCount: 2,
          hostConnected: true,
          seq: 1,
          unexpected: true,
        }),
      ),
    ).toBe(false);
  });

  test('rejects unknown keys in nested protocol payload objects', () => {
    expect(
      isBsyncWsClientMessage(
        createProtocolMessage('room:create', {
          displayName: 'Browser',
          targetPage: { ...page, unexpected: true },
        }),
      ),
    ).toBe(false);

    expect(
      isBsyncWsServerMessage(
        createProtocolMessage('room:snapshot', {
          snapshot: {
            roomId: 'ABC123',
            role: 'guest',
            peerCount: 2,
            hostConnected: true,
            targetPage: page,
            media: null,
            seq: 1,
            unexpected: true,
          },
        }),
      ),
    ).toBe(false);

    expect(
      isBsyncWsClientMessage(
        createProtocolMessage('media:snapshot', {
          media: {
            mediaKey: 'video-1',
            url: 'https://example.com/watch',
            paused: false,
            currentTime: 1,
            duration: 60,
            playbackRate: 1,
            updatedAt: 1,
            volume: 1,
          },
        }),
      ),
    ).toBe(false);
  });

  test('rejects invalid media and page payloads', () => {
    expect(
      isBsyncWsClientMessage(
        createProtocolMessage('media:snapshot', {
          media: {
            mediaKey: 'video-1',
            url: 'https://example.com/watch',
            paused: false,
            currentTime: Number.NaN,
            duration: 60,
            playbackRate: 1,
            updatedAt: 1,
          },
        }),
      ),
    ).toBe(false);
  });

  test('validates authoritative snapshots and sequence fields', () => {
    const snapshot = {
      roomId: 'ABC123',
      role: 'guest' as const,
      peerCount: 2,
      hostConnected: true,
      targetPage: page,
      media: null,
      seq: 4,
    };
    expect(
      isBsyncWsServerMessage(
        createProtocolMessage('room:joined', {
          roomId: 'ABC123',
          resumeToken: 'valid_resume_token_123',
          snapshot,
        }),
      ),
    ).toBe(true);
    expect(
      isBsyncWsServerMessage(
        createProtocolMessage('room:presence', {
          roomId: 'ABC123',
          peerCount: 2,
          hostConnected: true,
          seq: -1,
        }),
      ),
    ).toBe(false);
  });

  test('rejects inconsistent page identity and snapshot room identity', () => {
    expect(
      isBsyncWsClientMessage(
        createProtocolMessage('room:create', {
          displayName: 'Browser',
          targetPage: { ...page, hostname: 'trusted.example' },
        }),
      ),
    ).toBe(false);

    expect(
      isBsyncWsServerMessage(
        createProtocolMessage('room:joined', {
          roomId: 'ABC123',
          resumeToken: 'valid_resume_token_123',
          snapshot: {
            roomId: 'OTHER1',
            role: 'guest',
            peerCount: 2,
            hostConnected: true,
            targetPage: page,
            media: null,
            seq: 1,
          },
        }),
      ),
    ).toBe(false);
  });

  test('requires empty payloads to be empty', () => {
    expect(isBsyncWsClientMessage(createProtocolMessage('room:leave', {}))).toBe(true);
    expect(isBsyncWsClientMessage(createProtocolMessage('room:leave', { unexpected: true }))).toBe(false);
  });

  test('accepts authoritative no-media snapshots with sequence', () => {
    expect(
      isBsyncWsClientMessage(createProtocolMessage('media:snapshot', { media: null })),
    ).toBe(true);
    expect(
      isBsyncWsServerMessage(
        createProtocolMessage('media:snapshot', {
          roomId: 'ABC123',
          media: null,
          seq: 9,
        }),
      ),
    ).toBe(true);
    expect(
      isBsyncWsServerMessage(
        createProtocolMessage('media:command', {
          roomId: 'ABC123',
          commandId: 'command-1',
          media: null,
          seq: 10,
        }),
      ),
    ).toBe(true);
  });
});
