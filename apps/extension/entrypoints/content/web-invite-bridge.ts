import {
  WEB_BRIDGE_VERSION,
  isBsyncWebBridgeRequest,
  type BsyncWebBridgeResponse,
} from '@bsync/invite';

const MAX_SEEN_REQUESTS = 128;

function getAllowedOrigin(): string | null {
  const configured = import.meta.env.WXT_PUBLIC_WEB_ORIGIN;
  if (!configured) return null;
  try {
    return new URL(configured).origin;
  } catch {
    return null;
  }
}

export function startWebInviteBridge(): () => void {
  const allowedOrigin = getAllowedOrigin();
  const invitePath = location.pathname.replace(/\/$/u, '').replace(/\/index\.html$/u, '');
  if (
    !allowedOrigin ||
    location.origin !== allowedOrigin ||
    invitePath !== '/invite' ||
    window.self !== window.top
  ) return () => {};

  const seenRequestIds = new Set<string>();
  const requestOrder: string[] = [];
  let activeNonce: string | null = null;
  const respond = (response: BsyncWebBridgeResponse) => {
    window.postMessage(response, allowedOrigin);
  };

  const listener = (event: MessageEvent<unknown>) => {
    if (event.source !== window || event.origin !== allowedOrigin) return;
    if (!isBsyncWebBridgeRequest(event.data)) return;
    const request = event.data;
    if (seenRequestIds.has(request.requestId)) return;
    seenRequestIds.add(request.requestId);
    requestOrder.push(request.requestId);
    if (requestOrder.length > MAX_SEEN_REQUESTS) {
      seenRequestIds.delete(requestOrder.shift()!);
    }

    if (request.type === 'bsync:extension-probe') {
      activeNonce = crypto.randomUUID();
      respond({
        source: 'bsync:extension',
        version: WEB_BRIDGE_VERSION,
        type: 'bsync:extension-ready',
        requestId: request.requestId,
        ok: true,
        payload: { nonce: activeNonce },
      });
      return;
    }

    if (request.payload.nonce !== activeNonce || !navigator.userActivation?.isActive) {
      activeNonce = null;
      respond({
        source: 'bsync:extension',
        version: WEB_BRIDGE_VERSION,
        type: 'bsync:join-result',
        requestId: request.requestId,
        ok: false,
        error: 'Click Join room to authorize this invite',
      });
      return;
    }
    activeNonce = null;

    void browser.runtime.sendMessage({
      type: 'bsync:web-invite-join',
      payload: { invite: request.payload.invite },
    }).then((result: unknown) => {
      const outcome = result && typeof result === 'object' ? result as { ok?: unknown; error?: unknown } : null;
      respond({
        source: 'bsync:extension',
        version: WEB_BRIDGE_VERSION,
        type: 'bsync:join-result',
        requestId: request.requestId,
        ok: outcome?.ok === true,
        ...(typeof outcome?.error === 'string' ? { error: outcome.error.slice(0, 512) } : {}),
      });
    }).catch(() => {
      respond({
        source: 'bsync:extension',
        version: WEB_BRIDGE_VERSION,
        type: 'bsync:join-result',
        requestId: request.requestId,
        ok: false,
        error: 'The extension could not join this room',
      });
    });
  };

  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
