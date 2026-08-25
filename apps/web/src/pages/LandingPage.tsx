import { StoreCtas } from '../components';

export function LandingPage() {
  return (
    <>
      <section class="hero">
        <div class="hero-copy">
          <p class="eyebrow"><span>01</span> Synchronized browsing</p>
          <h1>Same moment.<br /><em>Different screens.</em></h1>
          <p class="hero-lede">BSync keeps a shared page and its video or audio playback aligned across browsers. You bring the content. BSync coordinates the controls.</p>
          <div class="hero-actions">
            <a class="bsync-button bsync-button--primary" href="#download">Get the extension <span aria-hidden="true">-&gt;</span></a>
            <a class="bsync-button" href="https://github.com/BADtochka/BSync" rel="noreferrer">Inspect source <span aria-hidden="true">^</span></a>
          </div>
        </div>
        <div class="sync-console" aria-label="Illustration of two synchronized browser sessions">
          <div class="console-header"><span>ROOM / A7F2C9</span><span class="bsync-status" data-tone="success">Synced</span></div>
          <div class="console-screen">
            <div class="play-symbol" aria-hidden="true">▶</div>
            <div><span class="bsync-label">HOST MEDIA</span><strong>01:23:08</strong></div>
          </div>
          <div class="console-track"><span /></div>
          <div class="console-peers">
            <span><i /> HOST / DESKTOP</span>
            <span><i /> GUEST / LAPTOP</span>
          </div>
        </div>
      </section>

      <section class="sequence" aria-labelledby="sequence-title">
        <div>
          <p class="eyebrow"><span>02</span> One clean sequence</p>
          <h2 id="sequence-title">Create. Share. Watch in sync.</h2>
        </div>
        <ol>
          <li><span>01</span><strong>Create</strong><p>Start a private room from the BSync extension.</p></li>
          <li><span>02</span><strong>Share</strong><p>Send one invite link. No server address or room code entry.</p></li>
          <li><span>03</span><strong>Sync</strong><p>Playback and page focus follow the room host.</p></li>
        </ol>
      </section>

      <section class="download" id="download" aria-labelledby="download-title">
        <div class="download-heading">
          <p class="eyebrow"><span>03</span> Install</p>
          <h2 id="download-title">Choose your browser.</h2>
          <p>Both store states are always shown. Your current browser is highlighted when detected.</p>
        </div>
        <StoreCtas />
      </section>
    </>
  );
}
