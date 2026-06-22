# BSync

<p align="center">
  <img src="apps/extension/public/logo.svg" alt="BSync logo" width="160" height="160" />
</p>

Interactive browser sync overlay extension and Bun WebSocket relay.

## Workspaces

- `apps/extension` - WXT + Preact browser extension.
- `apps/sync-server` - Bun WebSocket relay server.
- `packages/sync-protocol` - shared WebSocket protocol types.

## Features

- Preact popup for room, profile, status, overlay position, and compact mode.
- Content-script overlay rendered in a Shadow DOM on every page.
- Shared extension state via WXT storage, watched live by popup, overlay, and background.
- WebSocket relay for shared room page focus and media playback synchronization.

## Commands

```sh
bun run dev
bun run dev:sync-server  # restarts on changes in apps/sync-server and packages/sync-protocol
bun run build
bun run compile
bun run dev:firefox
bun run build:firefox
bun run sync-server
```

Load the generated development extension from `apps/extension/.output/chrome-mv3-dev`.
Firefox MV3 development builds are generated in `apps/extension/.output/firefox-mv3-dev`.
The local sync relay listens on `ws://localhost:8787`.
