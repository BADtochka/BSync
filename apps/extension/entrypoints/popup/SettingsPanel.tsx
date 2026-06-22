import { useState } from 'preact/hooks';
import {
  formatTimeAgo,
  normalizeTrustedDomain,
  type OverlayPosition,
  type SyncState,
} from '@/lib/sync-state';

const positions: Array<{ value: OverlayPosition; label: string }> = [
  { value: 'top-right', label: 'TR' },
  { value: 'top-left', label: 'TL' },
  { value: 'bottom-right', label: 'BR' },
  { value: 'bottom-left', label: 'BL' },
];

type SettingsPanelProps = {
  state: SyncState;
  onBack: () => void;
  onCommit: (
    updater: (current: SyncState) => SyncState,
    label?: string,
    tone?: 'info' | 'success' | 'warning' | 'error',
  ) => void;
  onResetData: () => Promise<void>;
};

export function SettingsPanel({ state, onBack, onCommit, onResetData }: SettingsPanelProps) {
  const [newDomain, setNewDomain] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [domainError, setDomainError] = useState<string | null>(null);
  const [isResetConfirming, setIsResetConfirming] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  const domains = state.trustedDomains ?? [];

  const persistDomains = (next: string[]) => {
    onCommit((current) => ({
      ...current,
      trustedDomains: next,
    }));
  };

  const handleAdd = () => {
    const normalized = normalizeTrustedDomain(newDomain);
    if (!normalized) {
      setDomainError('Enter a valid domain');
      return;
    }
    if (domains.includes(normalized)) {
      setDomainError('Domain already listed');
      return;
    }

    persistDomains([...domains, normalized]);
    setNewDomain('');
    setDomainError(null);
  };

  const startEdit = (index: number) => {
    setEditingIndex(index);
    setEditingValue(domains[index] ?? '');
    setDomainError(null);
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setEditingValue('');
    setDomainError(null);
  };

  const saveEdit = () => {
    if (editingIndex == null) return;

    const normalized = normalizeTrustedDomain(editingValue);
    if (!normalized) {
      setDomainError('Enter a valid domain');
      return;
    }
    if (domains.some((domain, index) => index !== editingIndex && domain === normalized)) {
      setDomainError('Domain already listed');
      return;
    }

    const next = [...domains];
    next[editingIndex] = normalized;
    persistDomains(next);
    cancelEdit();
  };

  const removeDomain = (index: number) => {
    persistDomains(domains.filter((_, itemIndex) => itemIndex !== index));
    if (editingIndex === index) {
      cancelEdit();
    } else if (editingIndex != null && editingIndex > index) {
      setEditingIndex(editingIndex - 1);
    }
  };

  const confirmResetData = async () => {
    setIsResetting(true);
    try {
      await onResetData();
      setIsResetConfirming(false);
      setDomainError(null);
      setNewDomain('');
      cancelEdit();
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <section className='settings-panel'>
      <div className='settings-header'>
        <button type='button' className='back-button' onClick={onBack}>
          Back
        </button>
        <h2>Settings</h2>
      </div>

      <div className='settings-group'>
        <span className='settings-label'>Overlay</span>
        <div className='field-row'>
          <span>Visible</span>
          <button
            type='button'
            className={state.overlayVisible ? 'toggle is-on' : 'toggle'}
            onClick={() =>
              onCommit(
                (current) => ({
                  ...current,
                  overlayVisible: !current.overlayVisible,
                }),
                state.overlayVisible ? 'Overlay hidden' : 'Overlay shown',
              )
            }
          >
            {state.overlayVisible ? 'On' : 'Off'}
          </button>
        </div>

        <div className='field-row'>
          <span>Compact</span>
          <button
            type='button'
            className={state.compact ? 'toggle is-on' : 'toggle'}
            onClick={() =>
              onCommit((current) => ({
                ...current,
                compact: !current.compact,
              }))
            }
          >
            {state.compact ? 'On' : 'Off'}
          </button>
        </div>

        <div className='segmented' aria-label='Overlay position'>
          {positions.map((position) => (
            <button
              key={position.value}
              type='button'
              className={state.position === position.value ? 'is-active' : ''}
              onClick={() =>
                onCommit((current) => ({
                  ...current,
                  position: position.value,
                }))
              }
            >
              {position.label}
            </button>
          ))}
        </div>
      </div>

      <div className='settings-group'>
        <div className='settings-field'>
          <span>Trusted domains</span>
          <small>
            When the host switches page, auto-open in the active tab only if it is already on a
            trusted domain. The In current tab button always uses the active tab.
          </small>

          {domains.length > 0 ? (
            <ul className='trusted-domain-list'>
              {domains.map((domain, index) => (
                <li key={`${index}-${domain}`} className='trusted-domain-item'>
                  {editingIndex === index ? (
                    <div className='trusted-domain-edit'>
                      <input
                        value={editingValue}
                        onInput={(event) => setEditingValue(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') saveEdit();
                          if (event.key === 'Escape') cancelEdit();
                        }}
                        autoFocus
                      />
                      <div className='trusted-domain-edit-actions'>
                        <button type='button' className='primary' onClick={saveEdit}>
                          Save
                        </button>
                        <button type='button' onClick={cancelEdit}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <span className='trusted-domain-name'>{domain}</span>
                      <div className='trusted-domain-actions'>
                        <button
                          type='button'
                          className='link-button'
                          onClick={() => startEdit(index)}
                        >
                          Edit
                        </button>
                        <span className='trusted-domain-separator' aria-hidden='true'>
                          |
                        </span>
                        <button
                          type='button'
                          className='link-button link-button--danger'
                          onClick={() => removeDomain(index)}
                        >
                          Delete
                        </button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className='empty'>No trusted domains yet</p>
          )}

          <div className='trusted-domain-add'>
            <input
              placeholder='youtube.com'
              value={newDomain}
              onInput={(event) => {
                setNewDomain(event.currentTarget.value);
                setDomainError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleAdd();
              }}
            />
            <button type='button' className='primary' onClick={handleAdd}>
              Add
            </button>
          </div>

          {domainError ? <p className='field-error'>{domainError}</p> : null}
        </div>
      </div>

      <div className='settings-group danger-zone'>
        <div className='settings-field'>
          <span>Extension data</span>
          <small>Clears room state, trusted domains, activity, and tracked tab snapshots.</small>

          {isResetConfirming ? (
            <div className='reset-confirmation'>
              <span>Reset all saved extension data?</span>
              <div className='reset-actions'>
                <button
                  type='button'
                  className='danger'
                  disabled={isResetting}
                  onClick={confirmResetData}
                >
                  {isResetting ? 'Resetting' : 'Confirm reset'}
                </button>
                <button
                  type='button'
                  disabled={isResetting}
                  onClick={() => setIsResetConfirming(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button type='button' className='danger' onClick={() => setIsResetConfirming(true)}>
              Reset all data
            </button>
          )}
        </div>
      </div>

      <div className='settings-group activity'>
        <div className='section-title'>
          <span>Activity log</span>
          <button
            type='button'
            onClick={() =>
              onCommit((current) => ({
                ...current,
                activity: [],
              }))
            }
          >
            Clear
          </button>
        </div>

        {state.activity.length > 0 ? (
          state.activity.map((item) => (
            <div key={item.id} className={`activity-item activity-item--${item.tone}`}>
              <span />
              <p>{item.label}</p>
              <time>{formatTimeAgo(item.at)}</time>
            </div>
          ))
        ) : (
          <p className='empty'>No events yet</p>
        )}
      </div>
    </section>
  );
}
