import {
  WEB_BRIDGE_VERSION,
  isBsyncWebBridgeResponse,
  type BsyncWebBridgeRequest,
  type BsyncWebBridgeResponse,
  type InviteEnvelopeV2,
} from '@bsync/invite';

export { isBsyncWebBridgeResponse as isExtensionBridgeResponse } from '@bsync/invite';

const REQUEST_TIMEOUT_MS = 1_500;
let extensionNonce: string | null = null;

function createRequestId(): string {
  return crypto.randomUUID();
}

function requestExtension(
  request: BsyncWebBridgeRequest,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<BsyncWebBridgeResponse> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener('message', receive);
      reject(new Error('BSync extension did not respond'));
    }, timeoutMs);

    function receive(event: MessageEvent<unknown>): void {
      if (event.source !== window || event.origin !== window.location.origin) return;
      if (!isBsyncWebBridgeResponse(event.data) || event.data.requestId !== request.requestId) return;
      window.clearTimeout(timeout);
      window.removeEventListener('message', receive);
      resolve(event.data);
    }

    window.addEventListener('message', receive);
    window.postMessage(request, window.location.origin);
  });
}

export async function probeExtension(): Promise<boolean> {
  try {
    const response = await requestExtension({
      source: 'bsync:web',
      version: WEB_BRIDGE_VERSION,
      type: 'bsync:extension-probe',
      requestId: createRequestId(),
    });
    extensionNonce = response.type === 'bsync:extension-ready' && response.ok
      ? response.payload?.nonce ?? null
      : null;
    return extensionNonce !== null;
  } catch {
    return false;
  }
}

export async function joinWithExtension(invite: InviteEnvelopeV2): Promise<void> {
  if (!extensionNonce) throw new Error('Probe the BSync extension before joining');
  const nonce = extensionNonce;
  extensionNonce = null;
  const response = await requestExtension({
    source: 'bsync:web',
    version: WEB_BRIDGE_VERSION,
    type: 'bsync:join-invite',
    requestId: createRequestId(),
    payload: { invite, nonce },
  }, 18_000);
  if (response.type !== 'bsync:join-result' || !response.ok) {
    throw new Error(response.error || 'The extension could not join this room');
  }
}
