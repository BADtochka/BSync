import {
  formatTimeAgo,
  getFocusRequestTitle,
  getTabPageLabel,
  resolveFocusRequestSource,
  statusLabel,
  type ContentPageSnapshot,
  type MediaSyncState,
  type LocalMediaSelection,
  type RoomFocusRequest,
  type SyncState,
  type TabSyncState,
} from '@/lib/sync-state';
import type { Ref } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { getMediaDisplayLabel } from './media';

function connectionLabel(state: SyncState): string {
  if (state.roomRole === 'guest' && !state.followHost) return 'Desynced';
  if (
    state.connectionState === 'synced' &&
    state.status === 'paused' &&
    state.transportStatus === 'online'
  ) return 'Synced | Paused';

  switch (state.connectionState) {
    case 'resolving-invite': return 'Resolving';
    case 'connecting': return 'Connecting';
    case 'joining': return 'Joining';
    case 'synced': return 'Synced';
    case 'reconnecting': return 'Reconnecting';
    case 'degraded': return 'Degraded';
    case 'error': return 'Error';
    case 'idle':
    default: return 'Idle';
  }
}

function serverLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

type OverlayPanelProps = {
  state: SyncState;
  pageSnapshot: ContentPageSnapshot;
  localMediaState: MediaSyncState | null;
  localMediaStatus: LocalMediaSelection['status'];
  mediaDriftLabel: string | null;
  isDragging: boolean;
  dragOffset: { x: number; y: number };
  panelRef: Ref<HTMLDivElement>;
  gripRef: Ref<HTMLDivElement>;
  onGripPointerDown: (event: PointerEvent) => void;
  onToggleCompact: () => void;
  onHide: () => void;
  onFollowHost: () => void;
  onResumeMedia: () => void;
  onOpenPendingFocus: (mode: 'current' | 'new', trustSite: boolean) => void;
};

function FocusRequestDetails({ request }: { request: RoomFocusRequest }) {
  const source = resolveFocusRequestSource(request);

  return (
    <div>
      <strong>{getFocusRequestTitle(source)}</strong>
      <small className='bsync-focus-page-title'>{request.targetPage.title}</small>
      <small className='bsync-focus-page-url'>{request.targetPage.url}</small>
    </div>
  );
}

export function OverlayPanel({
  state,
  pageSnapshot,
  localMediaState,
  localMediaStatus,
  mediaDriftLabel,
  isDragging,
  dragOffset,
  panelRef,
  gripRef,
  onGripPointerDown,
  onToggleCompact,
  onHide,
  onFollowHost,
  onResumeMedia,
  onOpenPendingFocus,
}: OverlayPanelProps) {
  const [trustFocusSite, setTrustFocusSite] = useState(false);
  const isDetached = state.roomRole === 'guest' && !state.followHost;
  const connectionUnhealthy =
    state.connectionState === 'connecting' ||
    state.connectionState === 'joining' ||
    state.connectionState === 'reconnecting' ||
    state.connectionState === 'degraded' ||
    state.connectionState === 'error';
  const overlayStatus = isDetached
    ? 'detached'
    : connectionUnhealthy
      ? state.connectionState === 'error' ? 'error' : 'connecting'
      : state.status;
  const overlayStatusLabel = isDetached
    ? 'Desynced'
    : connectionUnhealthy
      ? connectionLabel(state)
      : state.status === 'paused' && state.transportStatus === 'online'
      ? 'Synced | Paused'
      : statusLabel(state.status);
  const currentConnectionLabel = connectionLabel(state);
  const mediaSummary = state.roomMedia ? getMediaDisplayLabel(state.roomMedia) : 'No media';

  useEffect(() => {
    setTrustFocusSite(false);
  }, [state.pendingFocusRequest?.targetPage.url]);

  return (
    <div
      ref={panelRef}
      className={`bsync-overlay bsync-overlay--${state.position} ${
        state.compact ? 'is-compact' : ''
      } ${isDragging ? 'is-dragging' : ''}`}
      style={{
        transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)`,
      }}
    >
      <div ref={gripRef} className='bsync-grip' onPointerDown={onGripPointerDown} title='Drag overlay'>
        <span />
        <span />
        <span />
      </div>

      <div className='bsync-header'>
        <div className='bsync-brand'>
          <strong className='bsync-wordmark'>BSYNC</strong>
          <span className='bsync-role'>{state.roomRole === 'none' ? 'IDLE' : state.roomRole.toUpperCase()}</span>
        </div>
        <div className='bsync-connection'>
          <small>Connection</small>
          <span
            className={`bsync-status-icon bsync-status-icon--${overlayStatus}`}
            role='img'
            aria-label={overlayStatusLabel}
          >
            {overlayStatus === 'paused' ? (
              <svg viewBox='0 0 12 12' aria-hidden='true'>
                <rect x='2.5' y='2' width='2.5' height='8' rx='0.75' />
                <rect x='7' y='2' width='2.5' height='8' rx='0.75' />
              </svg>
            ) : overlayStatus === 'detached' || overlayStatus === 'error' ? (
              <svg viewBox='0 0 12 12' aria-hidden='true'>
                <path d='M3 3l6 6M9 3L3 9' />
              </svg>
            ) : (
              <span aria-hidden='true' />
            )}
          </span>
          <strong>{overlayStatusLabel}</strong>
        </div>
        <button type='button' onClick={onToggleCompact}>
          {state.compact ? 'Open' : 'Min'}
        </button>
      </div>

      <div className='bsync-body'>
        <div className='bsync-compact-summary' aria-label='Room summary'>
          <span><small>Connection</small><strong>{currentConnectionLabel}</strong></span>
          <span><small>Peers</small><strong>{state.peerCount}</strong></span>
          <span className='bsync-compact-media' title={mediaSummary}><small>Media</small><strong>{mediaSummary}</strong></span>
          <span title={state.serverUrl}><small>Server</small><strong>{serverLabel(state.serverUrl)}</strong></span>
          <span title={pageSnapshot.hostname}><small>Domain</small><strong>{pageSnapshot.hostname || 'Unknown'}</strong></span>
        </div>

        <div className='bsync-room'>
          <span>{state.roomCode}</span>
          <small>{state.roomRole === 'host' ? 'Host control' : state.followHost ? 'Following host' : 'Detached'}</small>
        </div>

        {state.roomRole !== 'host' && state.pendingFocusRequest ? (
          <div className='bsync-focus-request'>
            <FocusRequestDetails request={state.pendingFocusRequest} />
            <label className='bsync-focus-trust bsync-trust-switch'>
              <span>Always trust this site</span>
              <span className='bsync-trust-switch-control'>
                <input
                  type='checkbox'
                  checked={trustFocusSite}
                  onChange={(event) => setTrustFocusSite(event.currentTarget.checked)}
                />
                <span className='bsync-trust-switch-track' aria-hidden='true' />
              </span>
            </label>
            <div className='bsync-focus-actions'>
              <button
                type='button'
                className='is-primary'
                onClick={() => onOpenPendingFocus('current', trustFocusSite)}
              >
                In current tab
              </button>
              <button type='button' onClick={() => onOpenPendingFocus('new', trustFocusSite)}>
                In new tab
              </button>
            </div>
          </div>
        ) : null}

        {isDetached ? (
          <div className='bsync-detached'>
            <div>
              <strong>Not synced with host</strong>
              <small>{state.detachedReason ?? 'Local playback control'}</small>
            </div>
            <button type='button' className='is-primary' onClick={onFollowHost}>
              Follow host
            </button>
          </div>
        ) : null}

        {state.mediaActionRequired ? (
          <div className='bsync-detached'>
            <div>
              <strong>Playback needs permission</strong>
              <small>Browser autoplay policy blocked remote playback.</small>
            </div>
            <button type='button' className='is-primary' onClick={onResumeMedia}>
              Click to resume sync
            </button>
          </div>
        ) : null}

        <div className='bsync-progress' aria-label='Sync progress'>
          <span style={{ width: `${state.progressPercent}%` }} />
        </div>

        <div className='bsync-grid'>
          <div>
            <small>Peers</small>
            <strong>{state.peerCount}</strong>
          </div>
          <div>
            <small>Latency</small>
            <strong>{state.latencyMs}ms</strong>
          </div>
          <div>
            <small>Last sync</small>
            <strong>{formatTimeAgo(state.lastSyncedAt)}</strong>
          </div>
        </div>

        <p className='bsync-page'>
          {getTabPageLabel({
            tabId: 0,
            ...pageSnapshot,
            updatedAt: Date.now(),
          } satisfies TabSyncState)}
        </p>

        <p className='bsync-page'>
          {state.roomMedia ? `Host: ${getMediaDisplayLabel(state.roomMedia)}` : 'No room media found'}
        </p>

        {state.roomRole === 'guest' ? (
          <p className='bsync-page'>
            {localMediaState
              ? `Local: ${getMediaDisplayLabel(localMediaState)}${mediaDriftLabel ? ` · ${mediaDriftLabel}` : ''}`
              : localMediaStatus === 'reacquiring'
                ? 'Local: reacquiring media'
                : 'Local: no media found'}
          </p>
        ) : null}

        <div className='bsync-actions'>
          <button type='button' onClick={onHide}>
            Hide
          </button>
        </div>
      </div>
    </div>
  );
}
