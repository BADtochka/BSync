# BSync source build

The Firefox extension is built from the repository root with Bun 1.3.13.

```sh
bun install --frozen-lockfile
bun run --cwd packages/sync-protocol compile
bun run --cwd apps/extension compile
bun run zip:firefox
```

The install uses `bun.lock`; WXT is pinned in `apps/extension/package.json`. The
extension archive is written to `apps/extension/.output/bsync-<version>-firefox.zip`.
The final command also creates the matching source archive.

No minifier, compiler, or dependency is downloaded by the build command after the
frozen dependency installation.
