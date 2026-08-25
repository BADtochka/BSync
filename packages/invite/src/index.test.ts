import { describe, expect, test } from 'bun:test';
import {
  createInviteUrl,
  decodeInviteEnvelope,
  encodeInviteEnvelope,
  isBsyncWebBridgeRequest,
  isBsyncWebBridgeResponse,
  InviteValidationError,
  type InviteEnvelopeV2,
} from './index';

const invite: InviteEnvelopeV2 = {
  v: 2,
  serverUrl: 'wss://sync.example.com',
  roomId: 'ROOM01',
  inviteToken: 'invite_token_00000001',
  expiresAt: 2_000,
};

describe('invite codec', () => {
  test('round-trips a v2 envelope in a URL fragment', () => {
    const url = createInviteUrl('https://bsync.example', invite, { now: 1_000 });
    expect(url).toStartWith('https://bsync.example/invite#');
    expect(decodeInviteEnvelope(url, { now: 1_000 })).toEqual(invite);
    expect(new URL(url).search).toBe('');
  });

  test('supports local websocket and web origins only when enabled', () => {
    const local = { ...invite, serverUrl: 'ws://localhost:8787' };
    expect(() => encodeInviteEnvelope(local, { now: 1_000 })).toThrow(InviteValidationError);
    const encoded = encodeInviteEnvelope(local, { allowLocal: true, now: 1_000 });
    expect(decodeInviteEnvelope(encoded, { allowLocal: true, now: 1_000 })).toEqual(local);
    expect(() => createInviteUrl('http://localhost:4173', local, { now: 1_000 })).toThrow();
  });

  test('rejects expired, unknown-version, malformed, and oversized invites', () => {
    expect(() => decodeInviteEnvelope(encodeInviteEnvelope(invite, { now: 1_000 }), { now: 2_000 })).toThrow(
      'Invite has expired',
    );
    expect(() =>
      decodeInviteEnvelope(
        btoa(JSON.stringify({ ...invite, v: 1 })).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, ''),
        { now: 1_000 },
      ),
    ).toThrow('Invite version is not supported');
    expect(() => decodeInviteEnvelope('not-valid%')).toThrow('Invite payload is malformed');
    expect(() => decodeInviteEnvelope('a'.repeat(4097))).toThrow('Invite is too long');
  });

  test('rejects insecure remote servers and unknown fields', () => {
    expect(() => encodeInviteEnvelope({ ...invite, serverUrl: 'ws://sync.example.com' }, { now: 1_000 })).toThrow(
      'Invite server must use WSS',
    );
    expect(() =>
      decodeInviteEnvelope(
        btoa(JSON.stringify({ ...invite, unexpected: true }))
          .replaceAll('+', '-')
          .replaceAll('/', '_')
          .replace(/=+$/u, ''),
        { now: 1_000 },
      ),
    ).toThrow('Invite payload contains unknown fields');
  });
});

describe('web bridge messages', () => {
  test('accepts only bounded exact request shapes', () => {
    const probe = {
      source: 'bsync:web',
      version: 1,
      type: 'bsync:extension-probe',
      requestId: 'request_01',
    };
    expect(isBsyncWebBridgeRequest(probe)).toBe(true);
    expect(isBsyncWebBridgeRequest({ ...probe, unexpected: true })).toBe(false);
    expect(isBsyncWebBridgeRequest({ ...probe, requestId: 'x'.repeat(129) })).toBe(false);
    expect(isBsyncWebBridgeRequest({
      ...probe,
      type: 'bsync:join-invite',
      payload: { invite, nonce: 'nonce_01' },
    })).toBe(true);
  });

  test('rejects malformed responses and unknown fields', () => {
    const response = {
      source: 'bsync:extension',
      version: 1,
      type: 'bsync:extension-ready',
      requestId: 'request_01',
      ok: true,
    };
    expect(isBsyncWebBridgeResponse(response)).toBe(true);
    expect(isBsyncWebBridgeResponse({ ...response, token: 'secret' })).toBe(false);
    expect(isBsyncWebBridgeResponse({ ...response, error: 'x'.repeat(513) })).toBe(false);
  });
});
