# Release and Auto-Update

Berd uses [Tauri's updater plugin](https://v2.tauri.app/plugin/updater/). Release builds use a GitHub release feed and an Ed25519 verification key. Local and custom builds disable updates unless their distributor supplies a complete, trusted updater profile.

The endpoint and verification key form one trust contract. `scripts/release/build-tauri-release-config.mjs` requires an explicit `BERD_RELEASE_CHANNEL`; enabled profiles require both `BERD_UPDATER_ENDPOINT` and `BERD_UPDATER_PUBLIC_KEY`, enforce credential-free HTTPS, and never fall back to another channel. Disabled builds carry no updater endpoint, key, or plugin registration.

## Feed and assets

The release boundary is centralized in `scripts/release/release-channel.json`. The rolling release endpoint is:

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
- `Berd_X.Y.Z_linux-x86_64.rpm`
- `Berd_X.Y.Z_linux-x86_64.AppImage.tar.gz`
- `Berd_X.Y.Z_linux-x86_64.AppImage.tar.gz.sig`
- `Berd_X.Y.Z_linux-x86_64.AppImage.tar.gz.sha256`

The updater manifest contains `darwin-aarch64`, `windows-x86_64`, and `linux-x86_64`. Promotion cannot run until all three platform payloads are staged and reverified.

## Release flow

Release tags use canonical SemVer without build metadata, such as `v1.2.3` or `v1.2.3-rc.1`.

1. Draft notes with `just release-notes ... output=/tmp/vX.Y.Z.md`, then review the Markdown.
2. Run `just release-prepare X.Y.Z /tmp/vX.Y.Z.md`. It creates `release/vX.Y.Z`, synchronizes every release version and Cargo lock entry, updates `CHANGELOG.md`, validates, commits, pushes, and opens a PR.
3. Review and squash-merge the release PR after CI passes.
4. Run `just release-publish X.Y.Z`. It resolves the PR's squash-merge commit, verifies the committed release state, creates an annotated tag on that exact commit, and pushes only `refs/tags/vX.Y.Z`.
5. The workflow verifies that the checkout and canonical remote tag resolve to the same main-reachable commit and that the tag is annotated.
6. It creates or safely resumes an immutable versioned GitHub release using the matching `CHANGELOG.md` section.
7. The platform jobs produce the macOS app/DMG, Windows NSIS installer, and Linux AppImage/deb/rpm packages.
8. The macOS signing action signs, notarizes, and staples its artifacts. The Windows NSIS installer and Linux packages are published without platform-native code signatures.
9. Each platform produces a minisign-signed updater archive, SHA-256 digest, and attested source-bound provenance receipt. Minisign authenticates the Windows and Linux updater archives even though their enclosed payloads lack platform-native code signatures.
10. Promotion waits for all three platform jobs and approval in the GitHub `release` environment, then re-downloads and verifies every immutable staged artifact. It rejects version downgrades, rejects changed same-version manifests, and rechecks the rolling manifest immediately before publication.
11. The promotion script uploads all three platform payloads and uploads a three-platform `latest.json` last.

Uploading the manifest last keeps installed clients on the previous release if staging or verification fails. Rollback is a new, higher patch release containing reverted code rather than a lower manifest version.

The rolling feed must be anonymously downloadable before the first promotion. This is not possible while the release repository is private.

### Manual recovery

Recovery is limited to the same immutable tag and source:

```bash
gh workflow run release.yml \
  --repo block/berd \
  --ref v1.2.3 \
  -f tag=v1.2.3
```

Recovery verifies the selected tag and is source-bound to that immutable tag and commit. A complete platform payload is reused only after its attested receipt is checked during promotion; an incomplete platform payload is deleted as a unit and rebuilt before promotion.

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
- Confirm the updater archives contain `Berd.app`, the Windows NSIS installer, and the Linux AppImage respectively.
- Verify macOS code signing, Gatekeeper, stapling, entitlements, updater signatures for all platforms, and anonymous download. Confirm the expected unsigned-publisher warning for the Windows installer.
- Exercise an update from a prior test build.
- Confirm disabled builds do not register or invoke the updater.
- Exercise recovery and failed promotion; the previous manifest must remain active after failure.

## Key files

| File | Role |
|---|---|
| `scripts/release/release-channel.json` | Repository, rolling tag, and platform boundary |
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
