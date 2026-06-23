import { render } from 'preact';
import { SyncOverlay } from './content/overlay/SyncOverlay';
import { startMediaFrameSync } from './content/overlay/media-frame-sync';
import './content/styles.css';

function isTopFrame(): boolean {
  return window.self === window.top;
}

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  matchAboutBlank: true,
  cssInjectionMode: 'ui',
  runAt: 'document_idle',
  async main(ctx) {
    const stopMediaSync = startMediaFrameSync();
    ctx.onInvalidated(() => {
      stopMediaSync();
    });

    if (!isTopFrame()) return;

    const ui = await createShadowRootUi(ctx, {
      name: 'bsync-page-overlay',
      position: 'overlay',
      alignment: 'top-left',
      zIndex: 2147483647,
      inheritStyles: true,
      isolateEvents: true,
      onMount(container, _shadow, shadowHost) {
        shadowHost.style.pointerEvents = 'none';
        render(<SyncOverlay />, container);
        return container;
      },
      onRemove(container) {
        if (container) render(null, container);
      },
    });

    ui.mount();
  },
});
