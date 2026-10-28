# Standalone Berd Call

The standalone CLI is for Apple Silicon Macs. It installs without Berd.app or administrator privileges. It installs public `block/berd` releases, built from the same source and versioned release pipeline as Berd.

The release must contain the standalone archive and checksum that `release.yml` publishes, and the native standalone update guard. Releases without these assets cannot be installed with this script.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/block/berd/main/scripts/install-berd-call.sh | bash
```

The default location is `~/.local/bin/berd-call`. Add `~/.local/bin` to PATH if the installer tells you to. The executable keeps its Developer ID signature. The installer verifies the download against the release's SHA-256 checksum, checks that the archive contains one regular executable, and verifies its code signature, Block's Developer ID team and signing identifier before replacing an installation.

Use `--bin-dir DIR` to choose another directory, for example to keep an existing Berd.app/development symlink. The installer refuses to overwrite symlinks or unmanaged executables or install inside an application bundle. `--version X.Y.Z` selects a particular stable version for an explicit install or rollback.

## Updates

Starting a call checks for a newer stable release in the background. It follows Berd's promoted updater manifest, so a staged release isn't installed until its promotion is approved. Downloads happen while the call continues; the helper waits for every running call to release the native shared lock before atomically replacing the executable. A new call takes the same lock, so it cannot start during replacement. Repeated starts share a single update check. Download or verification failures keep the installed executable intact. Later calls retry the check. Automatic checks do not downgrade versions.

Set `BERD_CALL_AUTO_UPDATE=0` in the environment that launches Berd Call to disable automatic checks. Rerunning the installer checks for an update manually. The installed helper is `~/.local/bin/.berd-call/update`; it contains the installer logic, with no download of additional shell code. Rerun the installer to refresh that helper. Background diagnostics go to macOS system logging under `berd-call-update`.

The CLI inside Buzz stays pinned to the Buzz build. Repinning and releasing Buzz updates that copy. The CLI inside Berd.app uses Berd's existing app updater. Neither app bundle runs the standalone update helper.

## Verify without changing a real installation

```sh
node --test scripts/install-berd-call.test.mjs
```

These macOS tests exercise the installer in temporary directories, with fixture release downloads and signatures. They cover installation, update, following the promoted release, rollback prevention, failed verification, missing assets, unsupported platforms, symlink rejection and waiting for an active call lock. They do not replace a live call or verify production release publication.
