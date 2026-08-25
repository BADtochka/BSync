export function PrivacyPage() {
  return (
    <article class="policy">
      <header>
        <p class="eyebrow"><span>03</span> Local policy</p>
        <h1>Privacy without vague claims.</h1>
        <p>Effective August 25, 2026. This page describes the current open-source BSync web app, extension, and relay behavior.</p>
      </header>

      <section><h2>Website and invite handling</h2><p>This website does not use accounts, cookies, advertising, or analytics. A room invite is carried in the URL fragment, which browsers do not include in ordinary HTTP requests or Referer headers. The web app validates that fragment locally and keeps it in page memory only. It sends the invite to the BSync extension only when you explicitly select <strong>Join room</strong>.</p><p>The service worker stores the static app shell, fonts, icons, and compiled assets for offline use. It does not persist invite fragments or cache invite network responses. Your hosting provider may still process connection information such as IP address, timestamp, user agent, and requested path; the fragment is not part of that request.</p></section>

      <section><h2>Data stored in your browser</h2><p>The extension stores preferences such as the selected sync server, display name, client identifier, trusted domains, follow behavior, and overlay settings in browser extension storage. Active room credentials, including invite and resume capabilities, use browser session storage and are reset with the browser session rather than saved as permanent preferences. Browser-managed caches may retain this website's static files.</p></section>

      <section><h2>Data sent to a sync server</h2><p>When you create, join, or resume a room, the selected WebSocket relay receives room identifiers and bearer capabilities, your chosen display name, presence and heartbeat messages, and synchronization state. The relay assigns an ephemeral internal participant identifier. Synchronization state can include the selected page URL, title and hostname, plus media identifier or source, playback position, duration, play or pause state, playback rate, and timestamps. Your IP address is necessarily visible to the relay at the network layer.</p><p>BSync does not transmit or proxy the video or audio stream itself. It does not send cookies, account passwords, third-party authentication credentials, form input, page text, or payment data as part of the synchronization protocol.</p></section>

      <section><h2>Relay retention and recipients</h2><p>The included relay holds active room, participant, target-page, and playback state in process memory. It has no database or application access log. New invites expire after 24 hours. A room closes when its host leaves or fails to reconnect within the current 30-second grace period; disconnected guest resume state also expires after 30 seconds. Process restart clears all rooms. Operators of a selected or self-hosted relay and their infrastructure providers may apply separate network or proxy log retention policies.</p><p>Room synchronization data is delivered through the selected relay to participants in the same room. BSync does not sell it or send it to advertising or profiling services.</p></section>

      <section><h2>Your controls</h2><p>You can leave a room, change or clear extension preferences, disable the overlay, remove the extension, clear this site's browser data, or choose a different sync server. Removing the extension clears its storage according to your browser's behavior.</p></section>

      <section><h2>Source and contact</h2><p>The implementation can be inspected in the <a href="https://github.com/BADtochka/BSync" rel="noreferrer">BSync source repository</a>. Report privacy questions or implementation discrepancies through the repository's issue tracker.</p></section>
    </article>
  );
}
