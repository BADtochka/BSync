import {
  formatTimeAgo,
  getFocusRequestTitle,
  getTabPageLabel,
  resolveFocusRequestSource,
  statusLabel,
  type ContentPageSnapshot,
  type MediaSyncState,
  type RoomFocusRequest,
  type SyncState,
  type TabSyncState,
} from '@/lib/sync-state';
import type { Ref } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { getMediaDisplayLabel } from './media';

type OverlayPanelProps = {
  state: SyncState;
  pageSnapshot: ContentPageSnapshot;
  localMediaState: MediaSyncState | null;
  mediaDriftLabel: string | null;
  isDragging: boolean;
  dragOffset: { x: number; y: number };
  panelRef: Ref<HTMLDivElement>;
  gripRef: Ref<HTMLDivElement>;
  onGripPointerDown: (event: PointerEvent) => void;
  onToggleCompact: () => void;
  onHide: () => void;
  onFollowHost: () => void;
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
  mediaDriftLabel,
  isDragging,
  dragOffset,
  panelRef,
  gripRef,
  onGripPointerDown,
  onToggleCompact,
  onHide,
  onFollowHost,
  onOpenPendingFocus,
}: OverlayPanelProps) {
  const [trustFocusSite, setTrustFocusSite] = useState(false);

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
        <div>
          <span className={`bsync-dot bsync-dot--${state.status}`} />
          <strong>{statusLabel(state.status)}</strong>
        </div>
        <button type='button' onClick={onToggleCompact}>
          {state.compact ? 'Open' : 'Min'}
        </button>
      </div>

      <div className='bsync-body'>
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

        {state.roomRole === 'guest' && !state.followHost ? (
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
