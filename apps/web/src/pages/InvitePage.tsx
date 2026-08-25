import { decodeInviteEnvelope, InviteValidationError, type InviteEnvelopeV2 } from '@bsync/invite';
import { useEffect, useState } from 'preact/hooks';
import { StoreCtas } from '../components';
import { joinWithExtension, probeExtension } from '../extension-bridge';

type BridgeState = 'checking' | 'available' | 'unavailable' | 'joining' | 'joined' | 'error';

function parseFragment(): { invite: InviteEnvelopeV2 | null; error: string | null } {
  try {
    // The query string and page URL are deliberately never passed to the invite decoder.
    const fragment = window.location.hash;
    if (!fragment) return { invite: null, error: 'This link has no invite fragment.' };
    return {
      invite: decodeInviteEnvelope(fragment, {
        allowLocal: import.meta.env.DEV || import.meta.env.VITE_ALLOW_LOCAL_INVITES === 'true',
      }),
      error: null,
    };
  } catch (error) {
    if (error instanceof InviteValidationError) {
      const messages: Partial<Record<typeof error.code, string>> = {
        expired: 'This invite has expired. Ask the host for a new link.',
        'invalid-server': 'This invite points to an unsafe or invalid sync server.',
        'unsupported-version': 'This invite was created by an unsupported BSync version.',
      };
      return { invite: null, error: messages[error.code] || 'This invite is malformed or incomplete.' };
    }
    return { invite: null, error: 'This invite could not be read.' };
  }
}

export function InvitePage() {
  const [{ invite, error }, setInviteResolution] = useState(parseFragment);
  const [bridgeState, setBridgeState] = useState<BridgeState>('checking');
  const [bridgeError, setBridgeError] = useState<string | null>(null);

  useEffect(() => {
    const parseCurrentInvite = () => {
      setInviteResolution(parseFragment());
      setBridgeState('checking');
      setBridgeError(null);
    };
    window.addEventListener('hashchange', parseCurrentInvite);
    return () => window.removeEventListener('hashchange', parseCurrentInvite);
  }, []);

  useEffect(() => {
    if (!invite?.expiresAt) return;
    const remaining = invite.expiresAt - Date.now();
    if (remaining <= 0) {
      setInviteResolution(parseFragment());
      return;
    }
    const timeout = window.setTimeout(
      () => setInviteResolution(parseFragment()),
      remaining + 1,
    );
    return () => window.clearTimeout(timeout);
  }, [invite?.expiresAt]);

  useEffect(() => {
    if (!invite) return;
    let active = true;
    const probe = () => probeExtension().then((available) => {
      if (active) {
        setBridgeState((current) =>
          current === 'joining' || current === 'joined'
            ? current
            : available ? 'available' : 'unavailable',
        );
      }
    });
    const probeWhenVisible = () => {
      if (document.visibilityState === 'visible') void probe();
    };
    void probe();
    window.addEventListener('pageshow', probeWhenVisible);
    document.addEventListener('visibilitychange', probeWhenVisible);
    return () => {
      active = false;
      window.removeEventListener('pageshow', probeWhenVisible);
      document.removeEventListener('visibilitychange', probeWhenVisible);
    };
  }, [invite]);

  async function joinRoom(): Promise<void> {
    if (!invite || bridgeState !== 'available') return;
    setBridgeState('joining');
    setBridgeError(null);
    try {
      await joinWithExtension(invite);
      setBridgeState('joined');
    } catch (joinError) {
      setBridgeState('error');
      setBridgeError(joinError instanceof Error ? joinError.message : 'The room could not be opened.');
    }
  }

  async function retryExtension(): Promise<void> {
    setBridgeState('checking');
    setBridgeError(null);
    setBridgeState(await probeExtension() ? 'available' : 'unavailable');
  }

  if (!invite) {
    return (
      <section class="invite-layout">
        <div class="invite-panel invite-panel--error">
          <p class="eyebrow"><span>!</span> Invite rejected</p>
          <h1>Unable to resolve room.</h1>
          <p>{error}</p>
          <a class="bsync-button" href="/">Return home <span aria-hidden="true">-&gt;</span></a>
        </div>
      </section>
    );
  }

  const server = new URL(invite.serverUrl);
  const expiration = invite.expiresAt ? new Date(invite.expiresAt).toLocaleString() : 'Set by room server';
  return (
    <section class="invite-layout">
      <div class="invite-panel">
        <p class="eyebrow"><span>IN</span> Private room invite</p>
        <h1>You have a room to join.</h1>
        <dl class="invite-data">
          <div><dt>Room status</dt><dd><span class="bsync-status" data-tone="success">Invite valid</span></dd></div>
          <div><dt>Room</dt><dd>{invite.roomId}</dd></div>
          <div><dt>Relay</dt><dd>{server.host}</dd></div>
          <div><dt>Expires</dt><dd>{expiration}</dd></div>
        </dl>

        <div class="bridge-action" aria-live="polite">
          {bridgeState === 'checking' && <p class="bsync-status" data-tone="active">Checking for extension</p>}
          {bridgeState === 'available' && <button class="bsync-button bsync-button--primary" type="button" onClick={joinRoom}>Join room <span aria-hidden="true">-&gt;</span></button>}
          {bridgeState === 'joining' && <button class="bsync-button bsync-button--primary" type="button" disabled>Sending invite...</button>}
          {bridgeState === 'joined' && <p class="bsync-status" data-tone="success">Invite sent to BSync</p>}
          {bridgeState === 'error' && <><p class="bsync-status" data-tone="danger">Join failed</p><p>{bridgeError}</p><button class="bsync-button" type="button" onClick={retryExtension}>Try again</button></>}
          {bridgeState === 'unavailable' && <><p class="bsync-status" data-tone="warning">Extension not detected</p><p>Install BSync, return to this exact link, then reload once so the new extension can connect to the page.</p><button class="bsync-button" type="button" onClick={() => window.location.reload()}>Reload and detect</button></>}
        </div>
      </div>
      {bridgeState === 'unavailable' && <aside class="invite-install"><span class="bsync-label">Extension required</span><StoreCtas compact /></aside>}
      <p class="invite-security">The invite capability is read from the URL fragment only. It is not placed in page storage, logs, or the offline cache, and is shared with the extension only after you press Join room.</p>
    </section>
  );
}
