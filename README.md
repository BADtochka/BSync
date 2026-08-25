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
bun run publish:chrome
bun run sync-server
```

Load the generated development extension from `apps/extension/.output/chrome-mv3-dev`.
Firefox MV3 development builds are generated in `apps/extension/.output/firefox-mv3-dev`.
The local sync relay listens on `ws://localhost:8787`.

## Chrome Web Store release

Run the `Publish Chrome Web Store` workflow manually. It can bump `apps/extension/package.json`,
build the Chrome zip, upload it through the Chrome Web Store API, publish it, and push a matching
`vX.Y.Z` tag.

Authentication uses a Google Cloud service account linked in the Chrome Web Store Developer
Dashboard. This replaces the older OAuth client ID, client secret, and refresh token flow.

`Client ID for Chrome Extension` in Google Cloud Console is only for OAuth inside the extension
itself (`chrome.identity`). It has no client secret and is not used for CI publishing.

Required GitHub variables or secrets:

- `CHROME_EXTENSION_ID`
- `CHROME_PUBLISHER_ID`

Required GitHub secrets:

- `CHROME_SERVICE_ACCOUNT_KEY` - JSON key for a service account added under Account in the
  Chrome Web Store Developer Dashboard

## Firefox Add-ons release

Run the `Publish Firefox Add-on` workflow manually, or let it run automatically when a `v*` tag is
pushed (for example after a Chrome release).

Manual runs can bump `apps/extension/package.json`, build the Firefox zip, upload it to AMO, and
push a matching `vX.Y.Z` tag. Tag-triggered runs publish the version from the tag without bumping.

Required GitHub variables or secrets:

- `WXT_FIREFOX_EXTENSION_ID` - Firefox GUID in `{UUID}` or email-like form, for example
  `bsync@badtochka`; it must match the AMO listing

Required GitHub secrets:

- `FIREFOX_JWT_ISSUER`
- `FIREFOX_JWT_SECRET`
