# Browser regression fixtures

Serve this directory on two origins so the iframe cannot read its top frame URL:

```sh
bun tests/fixtures/serve.ts
```

Open `http://127.0.0.1:4173/iframe-host.html` for immediate media insertion, or
`http://127.0.0.1:4173/iframe-host.html?delay=3000` for delayed insertion. The top
document intentionally contains no `video` or `audio`; the only media candidate is
inside the cross-origin iframe.

Use **Replace media** to reproduce an iframe/player lifecycle change without
reloading the top document. During the Phase 0 baseline, inspect the extension
activity log for `media.candidate.detected`, `media.apply`, and
`media.apply.blocked` entries with tab/frame attribution.
