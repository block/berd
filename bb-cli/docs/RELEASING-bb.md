# Releasing `bb`

`bb` uses app and archive distribution artifacts. It is not installed or
managed through Homebrew, and it does not use the Homebrew-backed `sq`
command-pack release path. The `sq` release path is documented separately in
`docs/RELEASING-sq.md`.

## Local Verification

Before publishing `bb` artifacts:

```bash
source ./bin/activate-hermit
just package-bb-dmg
just package-bb-linux
```

Smoke-check the generated binaries:

```bash
dist/BuilderBot.app/Contents/Resources/bb --version
tar -tf dist/bb-linux-amd64.tgz
tar -tf dist/bb-linux-arm64.tgz
cat dist/bb-linux-SHA256SUMS
```

For local installer testing against generated artifacts:

```bash
BB_DOWNLOAD_BASE=file://"$PWD"/dist \
BB_INSTALL_DIR=/tmp/bb \
BB_INSTALL_BIN_DIR=/tmp/bb/bin \
script/install.sh
```

## macOS Artifacts

Build the macOS app, updater zip, and DMG:

```bash
source ./bin/activate-hermit
just package-bb-dmg
```

This produces:

```text
dist/BuilderBot.app
dist/BuilderBot-darwin.zip
dist/BuilderBot.dmg
```

Artifact roles:

| Artifact | Purpose |
| --- | --- |
| `dist/BuilderBot.app` | Local app bundle with embedded `bb`. |
| `dist/BuilderBot-darwin.zip` | App archive for installer and future updater flows. |
| `dist/BuilderBot.dmg` | First-install macOS distribution artifact. |

The macOS app bundles the CLI at:

```text
BuilderBot.app/Contents/Resources/bb
```

The app-managed CLI path is:

```text
/usr/local/bin/bb -> /Applications/BuilderBot.app/Contents/Resources/bb
```

## Linux Artifacts

Build both Linux architectures:

```bash
source ./bin/activate-hermit
just package-bb-linux
```

This uses Docker to build `amd64` and `arm64`, then produces:

```text
dist/bb-linux-amd64.tar.zst
dist/bb-linux-arm64.tar.zst
dist/bb-linux-amd64.tgz
dist/bb-linux-arm64.tgz
dist/bb-linux-SHA256SUMS
```

To build one Linux architecture:

```bash
just package-bb-linux-amd64
just package-bb-linux-arm64
```

The Linux archive layout is:

```text
bin/bb
share/bb/completions/_bb
```

## Installer

`script/install.sh` is the Ollama-style installer entrypoint.

On Linux it:

1. detects `amd64` or `arm64`
2. downloads `bb-linux-<arch>.tar.zst` when `zstd` is available
3. falls back to `bb-linux-<arch>.tgz`
4. installs under `/usr/local` by default
5. links or copies `bb` into the selected bin directory when needed

On macOS it:

1. downloads `BuilderBot-darwin.zip`
2. installs `BuilderBot.app` into `/Applications`
3. links `/usr/local/bin/bb` into the app bundle
4. starts `BuilderBot.app` unless `BB_NO_START=1`

Supported installer environment variables:

| Variable | Purpose |
| --- | --- |
| `BB_DOWNLOAD_BASE` | Base URL or `file://` path that contains release artifacts. |
| `BB_VERSION` | Optional version query parameter for hosted downloads. |
| `BB_INSTALL_DIR` | Linux install prefix. Defaults to `/usr/local`. |
| `BB_INSTALL_BIN_DIR` | Linux bin directory override. |
| `BB_NO_START` | Set to `1` to skip starting the macOS app after install. |

The published download directory should expose:

```text
install.sh
BuilderBot-darwin.zip
BuilderBot.dmg
bb-linux-amd64.tar.zst
bb-linux-arm64.tar.zst
bb-linux-amd64.tgz
bb-linux-arm64.tgz
bb-linux-SHA256SUMS
```

## Update Story

The app-managed `bb` channel updates by replacing `BuilderBot.app`. The bundled
CLI is the source of truth, and `/usr/local/bin/bb` remains a symlink into the
current app bundle.

The Linux channel updates by rerunning `script/install.sh` against the desired
release directory. The installer extracts the selected architecture archive over
the install prefix.

There is no Homebrew-managed `bb` channel. Do not publish a `bb` formula or
direct users to `brew install` / `brew upgrade`; releases should flow through
the app/archive artifacts above.

## Release Flow

1. Update and merge the version in `Cargo.toml`.
2. Run the local verification commands above.
3. Build macOS and Linux artifacts.
4. Sign and notarize macOS artifacts before external distribution.
5. Publish `install.sh`, macOS artifacts, Linux archives, and checksums to the
   `BB_DOWNLOAD_BASE` location.
6. Update the app update endpoint to point at the new macOS app zip when that
   endpoint exists.

The current scaffold generates local artifacts. CI publishing, notarization,
and the hosted update endpoint still need to be wired before this becomes a
fully automated release process.
