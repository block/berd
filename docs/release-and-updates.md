# Release and Auto-Update

Berd uses [Tauri's updater plugin](https://v2.tauri.app/plugin/updater/). The public macOS build uses a GitHub release feed and an Ed25519 verification key. Windows and Linux release artifacts are built and staged with the updater disabled until those platforms are ready for automatic distribution. Local and custom builds also disable updates unless their distributor supplies a complete, trusted updater profile.

The endpoint and verification key form one trust contract. `scripts/release/build-tauri-release-config.mjs` requires an explicit `BERD_RELEASE_CHANNEL`; enabled profiles require both `BERD_UPDATER_ENDPOINT` and `BERD_UPDATER_PUBLIC_KEY`, enforce credential-free HTTPS, and never fall back to another channel. Disabled builds carry no updater endpoint, key, or plugin registration.

## Feed and assets

The tag-bound release defaults are centralized in `scripts/release/release-channel.json`. The workflow narrows its promotion copy of that configuration to the platforms currently approved for automatic distribution. The rolling release endpoint is:

`https://github.com/block/berd/releases/download/berd-desktop-latest/latest.json`

Public releases must be at least `0.6.0-rc.1`. The app, bundled `berdctl`,
internal `tauri-plugin-berdctl`, their Cargo lock entries, and the changelog are
validated at the immutable tag before GitHub creates a release.

A version `X.Y.Z` publishes architecture-qualified assets for macOS, Windows, and Linux:

- `Berd_X.Y.Z_darwin-aarch64.app.zip`
- `Berd_X.Y.Z_darwin-aarch64.dmg`
- `Berd_X.Y.Z_darwin-aarch64.app.tar.gz`
- `Berd_X.Y.Z_darwin-aarch64.app.tar.gz.sig`
- `Berd_X.Y.Z_darwin-aarch64.app.tar.gz.sha256`
- `Berd_X.Y.Z_windows-x86_64-setup.exe`
- `Berd_X.Y.Z_windows-x86_64-setup.nsis.zip`
- `Berd_X.Y.Z_windows-x86_64-setup.nsis.zip.sig`
- `Berd_X.Y.Z_windows-x86_64-setup.nsis.zip.sha256`
- `Berd_X.Y.Z_linux-x86_64.AppImage`
- `Berd_X.Y.Z_linux-x86_64.deb`
- `Berd_X.Y.Z_linux-x86_64.AppImage.tar.gz`
- `Berd_X.Y.Z_linux-x86_64.AppImage.tar.gz.sig`
- `Berd_X.Y.Z_linux-x86_64.AppImage.tar.gz.sha256`

The updater manifest currently contains only `darwin-aarch64`. Windows and Linux artifacts are still attached to the versioned release for manual testing, but are not copied to the rolling updater release and do not gate promotion.

## Release flow

Release tags use canonical SemVer without build metadata, such as `v1.2.3` or `v1.2.3-rc.1`.

1. Run `just release-prepare X.Y.Z`. It generates and prints release notes, requires explicit approval, then creates `release/vX.Y.Z`, synchronizes every release version and Cargo lock entry, updates `CHANGELOG.md`, validates, commits, pushes, and opens a PR. Prerelease notes start at the latest release tag; stable notes start at the latest stable tag so they include the full release cycle.
2. Review and squash-merge the release PR after CI passes.
3. Run `just release-publish X.Y.Z`. It resolves the PR's squash-merge commit, verifies the committed release state, creates an annotated tag on that exact commit, and pushes only `refs/tags/vX.Y.Z`.
4. The workflow verifies that the checkout and canonical remote tag resolve to the same main-reachable commit and that the tag is annotated.
5. It creates or safely resumes an immutable versioned GitHub release using the matching `CHANGELOG.md` section.
6. The independent platform jobs produce the macOS app/DMG, Windows NSIS installer, and Linux AppImage/deb packages. Windows and Linux compile with `BERD_RELEASE_CHANNEL=disabled` so manual test installs do not query a feed that omits their platform.
7. The macOS signing action signs, notarizes, and staples its artifacts. The Windows NSIS installer and Linux packages are published without platform-native code signatures.
8. Each platform produces a minisign-signed updater archive, SHA-256 digest, and attested source-bound provenance receipt. Minisign authenticates the Windows and Linux updater archives even though their enclosed payloads lack platform-native code signatures.
9. Promotion waits for macOS staging and approval in the GitHub `release` environment, then re-downloads and verifies the immutable macOS payload. Windows and Linux continue independently and may finish before or after promotion. Promotion rejects version downgrades, rejects changed same-version manifests, and rechecks the rolling manifest immediately before publication.
10. The workflow gives the unchanged tag-bound promotion script a temporary macOS-only channel configuration. The script uploads the macOS payload and uploads `latest.json` last.

Uploading the manifest last keeps installed clients on the previous release if staging or verification fails. Rollback is a new, higher patch release containing reverted code rather than a lower manifest version.

### Re-enabling Windows or Linux auto-update

Do not add a platform to the manifest until its installer behavior and release posture are approved. To re-enable a platform, update `.github/workflows/release.yml` and its release workflow contract test together:

1. Change that platform job's `BERD_RELEASE_CHANNEL` to `public`, restore `BERD_UPDATER_ENDPOINT`, move `BERD_UPDATER_PUBLIC_KEY` from the packaging step back to the job environment, and restore its public-key preflight step. For Linux, also set `VITE_UPDATER_ENABLED=true`; the Windows bundle script derives the renderer gate from `BERD_RELEASE_CHANNEL`.
2. Add the platform job to `promote.needs` and require its result to be `success` or `skipped` in `promote.if`.
3. Verify the platform with `verify-versioned-release.sh` before promotion.
4. Add the platform ID to the temporary `.platforms` array passed to `promote-updater.sh`. Remove the temporary override once all platforms in `scripts/release/release-channel.json` are approved.
5. Exercise installation and update from a prior build on the platform, then confirm the rolling archive and manifest entry are anonymously downloadable.

Keep the updater public key scoped to the packaging step while a platform build is disabled. Packaging still signs and verifies its staged updater archive so the release lane exercises the future promotion artifact without enabling update checks in the application.

The rolling feed must be anonymously downloadable before the first promotion. This is not possible while the release repository is private.

### Manual recovery

Recovery is limited to the same immutable tag and source:

```bash
gh workflow run release.yml \
  --repo block/berd \
  --ref v1.2.3 \
  -f tag=v1.2.3
```

Recovery verifies the selected tag and is source-bound to that immutable tag and commit. A complete platform payload is reused; an incomplete platform payload is deleted as a unit and rebuilt. Promotion reverifies every platform selected for the rolling feed.

## Downstream distributions

Berd keeps build and bundle mechanics CI-neutral. A downstream distribution
checks out a reviewed Berd revision, supplies its updater and runtime
configuration, invokes the normal builders, then owns signing and publication.

Custom macOS builds use `BUILD_KIND=custom` with
`BERD_RELEASE_CHANNEL=disabled`. `scripts/release/build-macos.sh` validates their
configuration, stamps the suffixed version, stages resources, and builds the
unsigned app; distribution-specific orchestration and artifact destinations do
not live in this repository.

## GitHub repository setup

`block/berd` must have a `release` environment that requires maintainer review,
prevents self-approval, and allows deployments only from `v*` tags. Configure
the `BERD_UPDATER_PUBLIC_KEY`, `TAURI_SIGNING_PRIVATE_KEY`,
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `OSX_CODESIGN_ROLE`, and
`CODESIGN_S3_BUCKET` secrets used by the workflow.

Protect `v*` with paired repository rulesets: one restricts tag creation to
release maintainers, while the other has no bypass and blocks tag updates,
deletion, and force changes.

## Verification before promotion

- Run `just ci` and the release script tests.
- Verify that tag, checkout SHA, release target, and staged asset digest agree.
- Confirm the staged updater archives contain `Berd.app`, the Windows NSIS installer, and the Linux AppImage respectively.
- Verify macOS code signing, Gatekeeper, stapling, entitlements, updater signatures for all staged platforms, and anonymous download of every promoted platform. Confirm the expected unsigned-publisher warning for the Windows installer.
- Exercise an update from a prior test build.
- Confirm disabled builds do not register or invoke the updater.
- Exercise recovery and failed promotion; the previous manifest must remain active after failure.

## Key files

| File | Role |
|---|---|
| `scripts/release/release-channel.json` | Repository, rolling tag, and tag-bound platform defaults |
| `scripts/release/lib.sh` | Release validation, naming, paths, and explicit inputs |
| `scripts/release/version.mjs` | Shared canonical SemVer parsing and comparison |
| `scripts/release/release.mjs` | Lockstep version checks and prepare/publish maintainer commands |
| `scripts/release/build-macos.sh` | Version, resources, sidecar, and macOS build |
| `scripts/release/build-tauri-release-config.mjs` | Fail-closed updater profile overlay |
| `scripts/release/package-signed-updater.sh` | macOS signed-app verification, archive, signature, and digest |
| `scripts/release/package-signed-updater-windows.sh` | Windows updater archive, signature, and digest |
| `scripts/release/package-signed-updater-linux.sh` | Linux updater archive, signature, and digest |
| `scripts/release/verify-updater-signature.sh` | Verifies updater signatures against the embedded key |
| `scripts/release/generate-latest-json.sh` | Validates and creates the updater manifest |
| `scripts/release/validate-manifest-promotion.mjs` | Enforces monotonic, idempotent rolling-manifest publication |
| `scripts/release/github/` | GitHub release verification, immutable upload, and promotion adapters |
| `.github/workflows/release.yml` | Tag/recovery staging and approval-gated promotion |
| `src/features/updates/hooks/UpdaterProvider.tsx` | Update check, download, install, and restart state |
| `src-tauri/src/lib.rs` | Registers the updater only when configured |
