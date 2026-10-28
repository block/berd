# Standalone Berd Call

The standalone CLI is for Apple Silicon Macs. It installs without Berd.app or administrator privileges. Its releases use the same source and versioned release pipelines as Berd. Public downloads come from `block/berd`; internal downloads require access to `squareup/berd-internal` and an authenticated GitHub CLI (`gh`).

The release must contain the standalone archive and checksum produced by the CLI packaging pipeline, and the native standalone update guard. Releases without these assets cannot be installed with this script.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/block/berd/main/scripts/install-berd-call.sh | bash
```

The default location is `~/.local/bin/berd-call`. Add `~/.local/bin` to PATH if the installer tells you to. The executable keeps its Developer ID signature. The installer verifies the download against the release's SHA-256 checksum, checks that the archive contains one regular executable, and verifies its code signature and signing identifier before replacing an installation.

To install an internal release:

```sh
curl -fsSL https://raw.githubusercontent.com/block/berd/main/scripts/install-berd-call.sh | bash -s -- --channel internal
```

Use `--bin-dir DIR` to choose a separate directory for another channel or to keep an existing Berd.app/development symlink. The installer refuses to overwrite symlinks or unmanaged executables, install inside an application bundle, or change an existing installation's channel. `--version X.Y.Z` selects a particular stable version for an explicit install or rollback.

## Updates

Starting a call checks for a newer stable release in the background. Downloads happen while the call continues; the helper waits for every running call to release the native shared lock before atomically replacing the executable. A new call takes the same lock, so it cannot start during replacement. Repeated starts share a single update check. Download or verification failures keep the installed executable intact. Later calls retry the check. Automatic checks do not downgrade versions.

Set `BERD_CALL_AUTO_UPDATE=0` in the environment that launches Berd Call to disable automatic checks. Rerunning the installer checks for an update manually. The installed helper is `~/.local/bin/.berd-call/update`; it contains the installer logic and channel, with no download of additional shell code. Rerun the installer to refresh that helper. Background diagnostics go to macOS system logging under `berd-call-update`.

The CLI inside Buzz stays pinned to the Buzz build. Repinning and releasing Buzz updates that copy. The CLI inside Berd.app uses Berd's existing app updater. Neither app bundle runs the standalone update helper.

## Verify without changing a real installation

```sh
node --test scripts/install-berd-call.test.mjs
```

These macOS tests exercise the installer in temporary directories, with fixture release downloads and signatures. They cover installation, update, rollback prevention, channel retention, failed verification, missing assets, unsupported platforms, symlink rejection and waiting for an active call lock. They do not replace a live call or verify production release publication.
