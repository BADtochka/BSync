# BSync

<p align="center">
  <img src="assets/logo.svg" alt="BSync logo" width="160" height="160" />
</p>

Interactive browser sync overlay extension built with WXT and React.

## Features

- React popup for room, profile, status, overlay position, and compact mode.
- Content-script overlay rendered in a Shadow DOM on every page.
- Shared extension state via WXT storage, watched live by popup, overlay, and background.
- Demo sync controls for manual sync, pause/resume, hidden overlay state, and drift simulation.

## Commands

```sh
bun run dev
bun run build
bun run compile
bun run dev:firefox
bun run build:firefox
bun run sync-server
```

Load the generated development extension from `.output/chrome-mv3-dev`.
Firefox MV3 development builds are generated in `.output/firefox-mv3-dev`.
The local sync relay listens on `ws://localhost:8787`.
