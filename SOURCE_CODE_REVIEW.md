# BSync Firefox source review

The source ZIP contains the complete source and lockfile needed to rebuild the
Firefox extension. Use a clean directory, Bun 1.3.13, and a network connection
for the initial dependency installation only.

```sh
unzip bsync-<version>-sources.zip -d bsync-source
cd bsync-source
set -a
. ./BUILD_ENVIRONMENT.txt
set +a
bun install --frozen-lockfile
bun run --cwd packages/sync-protocol compile
bun run --cwd packages/invite compile
bun run --cwd packages/ui compile
bun run --cwd apps/extension build:firefox
```

The unpacked extension is written to
`apps/extension/.output/firefox-mv3`. To create the submission ZIP as well, run:

```sh
bun run --cwd apps/extension zip:firefox
```

The extension archive is written to
`apps/extension/.output/bsync-<version>-firefox.zip`. That command also creates
the matching reproducible source archive.

The install is locked by `bun.lock`; WXT 0.20.25 is pinned in
`apps/extension/package.json`. No minifier, compiler, dependency, or remote code
is downloaded by the compile/build commands after the frozen installation.

## AMO disclosure metadata

The Firefox manifest declares the categories used by BSync room authorization,
the user-selected display name, page synchronization, and playback interaction.
These declarations must remain aligned with `PRIVACY_POLICY.md` and the AMO
listing when the protocol changes.
