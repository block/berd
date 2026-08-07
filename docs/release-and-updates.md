# Release and Auto-Update

## Release channels

Berd uses [Tauri's updater plugin](https://v2.tauri.app/plugin/updater/). Every release build selects exactly one build-time updater profile:

| `BERD_RELEASE_CHANNEL` | Endpoint and key | Publisher |
|---|---|---|
| `public` | GitHub rolling release endpoint + public Ed25519 key | `.github/workflows/public-release.yml` |
| `internal` | Artifactory endpoint + distinct internal Ed25519 key | `.buildkite/release.yml` |
| `disabled` | no endpoint, key, or updater plugin registration | custom/local builds |

The endpoint and verification key are one trust contract. `scripts/release/build-tauri-release-config.mjs` requires `BERD_RELEASE_CHANNEL`; enabled profiles require both `BERD_UPDATER_ENDPOINT` and `BERD_UPDATER_PUBLIC_KEY`, enforce credential-free HTTPS, and never fall back to another channel. `disabled` rejects either value and emits an empty overlay. Runtime arbitrary URL selection is intentionally unsupported.

The renderer also receives `VITE_UPDATER_ENABLED=true` only for enabled profiles. On the Rust side, `tauri-plugin-updater` is registered only when the merged config contains a non-empty updater public key. A disabled build therefore neither polls nor carries an endpoint/key/plugin registration.

Public and internal Berd do not need to coexist. They retain the same app name, bundle identifier, deep-link scheme, and data directory. Installing one may replace the other; each binary polls only the feed/key baked into its build.

## Public feed and assets

The public release boundary is centralized in `scripts/release/public-channel.json`:

```json
{
  "repository": "squareup/berd",
  "rollingTag": "berd-desktop-latest",
  "platform": "darwin-aarch64"
}
```

The public endpoint is:

`https://github.com/squareup/berd/releases/download/berd-desktop-latest/latest.json`

A version `X.Y.Z` publishes architecture-qualified assets, avoiding the filename collision that occurs when multiple macOS architectures share `Berd.app.tar.gz`:

- `Berd_X.Y.Z_darwin-aarch64.app.zip`
- `Berd_X.Y.Z_darwin-aarch64.dmg`
- `Berd_X.Y.Z_darwin-aarch64.app.tar.gz`
- `Berd_X.Y.Z_darwin-aarch64.app.tar.gz.sig`
- `Berd_X.Y.Z_darwin-aarch64.app.tar.gz.sha256`

Only Apple Silicon is supported by this workflow. Adding x86_64, Windows, or Linux is separate product/release work.

## Public release flow

Public release tags use canonical SemVer without build metadata (for example, `v1.2.3` or `v1.2.3-rc.1`). Numeric identifiers cannot have leading zeroes.

1. An authorized human creates and pushes a protected `v<semver>` tag. The workflow also supports manual recovery dispatch, but its required `tag` input must name the same already-existing tag selected as the workflow run ref. Setup checks out that requested ref before reading release code, then validates it with the shared helper from the same immutable checkout.
2. `scripts/release/github/verify-release-ref.sh` verifies local `HEAD`, the local tag target, and the canonical `origin` tag all resolve to the same commit. A dispatch cannot build a branch head while claiming a version.
3. The workflow creates the immutable versioned GitHub release if it does not exist. Recovery reuses an existing complete staged payload without rebuilding; if assets are incomplete, the workflow rebuilds and `scripts/release/github/upload-immutable-assets.sh` confirms existing assets are byte-identical before filling only missing assets.
4. Before promotion, `scripts/release/github/verify-versioned-release.sh` independently rechecks the release tag/commit binding plus the exact non-empty staged asset set.
5. `scripts/release/build-macos.sh` stamps the version, stages Berd's pinned Goose/backend/CLI resources, generates the `public` updater overlay, and builds an unsigned Apple Silicon app. The internal Buildkite pipeline invokes this same implementation.
6. Pinned `block/apple-codesign-action@679535d…` receives Berd's existing unsigned styled DMG, signs/notarizes/staples its app through GitHub OIDC, and returns both the signed app zip and a DMG rebuilt around that same signed app. The job verifies code signatures, Gatekeeper, stapling, every committed entitlement, and the returned DMG.
7. `scripts/release/package-signed-updater.sh` extracts the signed `.app.zip`, repeats those checks, archives the signed `Berd.app`, Tauri-signs it, verifies the signature against the public key embedded in the app, and records SHA-256. The immutable release receives the app zip, DMG, updater archive, signature, and digest.
8. The `promote` job waits on the GitHub `public-release` environment. Required reviewers approve or reject it. After approval it first verifies that GitHub exposes the approval record, then re-downloads the exact updater archive/signature/digest from the versioned release; it never rebuilds or re-signs.
9. `scripts/release/github/promote-public-updater.sh` verifies digest, updater signature, archive root, repository boundary, and unauthenticated public download. It uploads version-qualified payloads to `berd-desktop-latest`, generates and validates `latest.json`, and uploads `latest.json` last.
10. The promotion job is serialized with `berd-public-release` and `cancel-in-progress: false`. The run summary records version, source SHA, digest, workflow run, and the GitHub environment review record.

A failure before `latest.json` upload leaves installed clients on the prior manifest. Rollback is a new higher patch release containing reverted code, not a lower manifest version.

`squareup/berd` is private today, so staging and every authenticated immutability/signature check can run there, but end-to-end promotion intentionally cannot succeed: the script requires its rolling archive to be downloadable without `GH_TOKEN`, just as installed updater clients require. Make the repository public (or migrate to the public `block/berd` destination) before the first promotion, then verify the archive and `latest.json` anonymously.

### Manual recovery

Recovery is only for the same immutable tag and source:

```bash
gh workflow run public-release.yml \
  --repo squareup/berd \
  --ref v1.2.3 \
  -f tag=v1.2.3
```

The selected dispatch ref and the required `tag` input must be the same existing immutable tag. The workflow checks out `v1.2.3`, verifies it against `origin`, and reuses a complete staged payload without rebuilding. If the versioned release is incomplete, it rebuilds from that same immutable tag, confirms every existing asset is byte-identical, and uploads only missing assets. It cannot overwrite different immutable bytes.

## Internal and custom flows

The internal Buildkite path remains in place:

1. `.buildkite/release.yml` selects `BERD_RELEASE_CHANNEL=internal` and the existing unauthenticated Artifactory feed.
2. `scripts/release/build-macos.sh` is the same CI-neutral build implementation used by GitHub Actions; the `squareup/apple-codesign` plugin signs/notarizes/staples and emits the signed `.app.zip` and DMG.
3. `scripts/buildkite/release/publish-updater.sh` calls the same CI-neutral `scripts/release/package-signed-updater.sh`, remapping existing `GOOSE2_TAURI_*` secrets only at this compatibility boundary.
4. `scripts/buildkite/release/publish-updater-to-artifactory.sh` uploads the version/platform-qualified updater archive, signature, and digest to `mdx/goose-internal/v<VERSION>/`; the existing `publish_latest` Buildkite input gates `latest.json`, which remains last.
5. `scripts/buildkite/release/publish-release.sh` continues publishing the internal GitHub release artifacts.

`.buildkite/custom-release.yml` explicitly selects `BERD_RELEASE_CHANNEL=disabled`. Custom builds still apply their one-off runtime/build configuration and publish signed zip/DMG assets to their named Artifactory path, but cannot publish or consume an updater feed.

Internal URLs:

| Resource | Location |
|---|---|
| Updater endpoint | `https://global.block-artifacts.com/artifactory/mdx/goose-internal/latest.json` |
| Versioned updater | `.../v<VERSION>/Berd_<VERSION>_darwin-aarch64.app.tar.gz` |
| Custom downloads | `.../mdx/berd-custom/<custom_name>/v<VERSION>/` |

## Distribution inputs

A distribution that packages Berd against its own gateway may supply two narrow, validated provider values to `build-macos.sh`. Both are optional and independent, and each is read from Buildkite meta-data or, for an orchestrator driving the build directly, from the uppercased env var:

| Input | Env var | Injected as | Effect |
|-------|---------|-------------|--------|
| `databricks_host` | `DATABRICKS_HOST` | `goose.modelProviders[databricks_v2].endpointEnv.DATABRICKS_HOST` | Packages the distribution's workspace host instead of leaving the provider host editable |
| `fast_model_id` | `FAST_MODEL_ID` | `goose.modelProviders[databricks_v2].fastModelId` | Exported to `goose serve` as `GOOSE_FAST_MODEL`, so Goose's lightweight tasks (session naming, compaction, tool-call titles) route to that endpoint instead of reusing the main model |

The `fast_model_id` input is deliberately *not* named `GOOSE_FAST_MODEL`: an input sharing the runtime env name Goose consumes would let an ambient value on the build agent silently become the bundled value.

`scripts/set-runtime-config-distribution.ts` applies whichever values are supplied — normalizing the host to a canonical HTTPS origin and the fast model to a served endpoint id — and re-parses the config against the shared schema; `validate-runtime-config.ts --strict-toggles` then runs once over the result. With neither input set, the injector never runs and the committed `runtime-config.json` ships as-is: no fast model, so Goose reuses the main model for fast tasks.

A custom build with `VITE_BYO_KEY_PROVIDERS=1` strips both fields back out before building, so a BYO-key bundle never carries a distribution's host or fast model.

## Owner/admin setup before first public release

Repository code cannot perform these operations. An owner/admin must:

1. **Generate a distinct public updater Ed25519 keypair**:

   ```bash
   pnpm exec tauri signer generate -- --write-keys ~/.tauri/berd-public-release.key
   ```

   Escrow the private key/password in the approved secret manager. Do not reuse `GOOSE2_*` internal keys.

2. Configure repository secret `TAURI_SIGNING_PRIVATE_KEY` and repository secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` with the public private half/password.
3. Configure repository variable `BERD_PUBLIC_UPDATER_PUBLIC_KEY` with the public half. The build embeds it in public-channel apps, so it is a non-secret repository variable.
4. Ask the Apple codesigning owners to authorize `squareup/berd`. Configure `OSX_CODESIGN_ROLE` and `CODESIGN_S3_BUCKET`, update AWS IAM OIDC trust for this repository, and confirm the pinned action commit is allowed. The release job alone gets `id-token: write`.
5. Create GitHub environment **`public-release`**, require reviewers, restrict deployments to protected `v*` tags/workflow policy, and do not bypass its approval for ordinary releases.
6. Set default Actions token permissions read-only. The workflow grants only setup/stage/promotion jobs `contents: write`; only signing receives `id-token: write`; promotion receives only the additional `actions: read`/`deployments: read` needed to preflight and record environment approval.
7. Protect `v*` tags against unauthorized creation, deletion, and force-update. Start with manual authorized tag creation; no release-tagger GitHub App or PAT is required. For recovery, select the existing tag itself as the workflow run ref and pass that same tag in the required input; this keeps the privileged workflow definition tag-bound rather than loading it from a movable branch.
8. Confirm Actions may create GitHub Releases and upload assets. The workflow idempotently creates `berd-desktop-latest` on first promotion.
9. Make the release repository public before end-to-end promotion. While it remains private, use the staging path to validate authenticated release creation, signing, immutable upload/recovery, and pre-promotion verification only.
10. Keep existing internal Buildkite secrets: `GOOSE2_UPDATER_PUBLIC_KEY`, `GOOSE2_TAURI_SIGNING_PRIVATE_KEY`, `GOOSE2_TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and `MOBUILD_ARTIFACTORY_UPLOAD_TOKEN`.

### Key rotation

The verification key is baked into installed apps. Do not simply replace the repository variable/secret. Publish a bridge release signed by the old key whose binary trusts the new public key/feed, allow supported installs to cross the bridge, then sign later releases with the new key. Keep the old private key until the supported installed population has crossed. Losing the active private key without a bridge requires manual reinstall.

## Move from `squareup/berd` to `block/berd`

The mechanism does not change. At migration:

1. Update only `repository` in `scripts/release/public-channel.json` from `squareup/berd` to `block/berd`. The workflow derives the baked endpoint and promotion URLs from this file/output boundary.
2. Recreate repository variables/secrets and the `public-release` environment/review rules in `block/berd`.
3. Update Apple codesigning AWS OIDC trust and codesigning authorization from the old repo claims to the new repo/environment claims.
4. Recreate protected `v*` tag rules and least-privilege Actions settings.
5. Decide feed continuity before release. Existing public installs contain the old `squareup/berd` endpoint. If GitHub does not preserve the release-asset URL after transfer, publish an old-feed bridge release before moving or retain a redirect/old rolling release. The updater signing key may stay the same across a repository move only if this is the same public trust channel; never substitute the internal key.
6. Run a non-promoting tagged test, approve promotion, and verify unauthenticated archive/manifest access off the corporate network before announcing the new public feed.

## Validation before first promotion

- Run `just ci` and static workflow/shell validation.
- Verify tag, checkout SHA, versioned release target, and staged asset SHA-256 agree.
- Inspect the updater archive and confirm the root is signed `Berd.app`, not an unsigned build output.
- Verify codesign, Gatekeeper, stapling, entitlements, and anonymous HTTP download. Exercise an update from a prior public test build to validate the Tauri signature end to end.
- Install the prior public test build on the oldest supported arm64 macOS version; observe check, download, install, restart, version, and data preservation.
- Confirm an internal build polls only Artifactory, a public build only GitHub, and a disabled/custom build never invokes the updater.
- Exercise recovery and failed promotion. An archive failure must leave the previous `latest.json`; concurrent promotions must serialize.

## Local profile checks

```bash
BERD_RELEASE_CHANNEL=internal \
BERD_UPDATER_PUBLIC_KEY='<internal-public-key>' \
BERD_UPDATER_ENDPOINT='https://global.block-artifacts.com/artifactory/mdx/goose-internal/latest.json' \
  pnpm run tauri:release:config

BERD_RELEASE_CHANNEL=disabled pnpm run tauri:release:config

pnpm test:release-scripts
```

Generated `src-tauri/tauri.release.conf.json` is gitignored.

## Key files

| File | Role |
|---|---|
| `scripts/release/public-channel.json` | centralized repo/rolling tag/platform migration boundary |
| `scripts/release/lib.sh` | CI-neutral release validation, naming, paths, and explicit input helpers |
| `scripts/release/build-macos.sh` | CI-neutral version/resource/sidecar build implementation |
| `scripts/release/build-tauri-release-config.mjs` | fail-closed updater profile overlay |
| `scripts/release/package-signed-updater.sh` | CI-neutral signed-app verification, archive, signing, digest |
| `scripts/release/verify-updater-signature.sh` | verifies Tauri updater signatures against the key embedded in the app |
| `scripts/release/generate-latest-json.sh` | validates and creates the public manifest |
| `scripts/release/github/` | GitHub-only signed-output preparation, tag/release verification, immutable upload, and manifest-last promotion adapters |
| `scripts/buildkite/release/` | Buildkite/Artifactory adapters and pipeline-input bridge |
| `.github/workflows/public-release.yml` | tag/recovery staging plus approval-gated promotion |
| `scripts/set-runtime-config-distribution.ts` | injects the optional distribution-owned Databricks host and fast model into bundled runtime config |
| `src/features/updates/hooks/UpdaterProvider.tsx` | update checks/download/install/restart UI state |
| `src-tauri/src/lib.rs` | conditionally registers updater plugin from baked config |

## Bundled Main/Beta catalogs

A distribution may replace the legacy one-channel profile with
`BERD_RELEASE_CHANNELS_FILE`, a reviewed schema-v1 catalog of finite channel
IDs. Each entry carries its HTTPS manifest endpoint, updater public key,
display metadata, and compatibility range. `BERD_RELEASE_CHANNEL_ID`
identifies the binary being built. Endpoint and key values never cross the
renderer boundary; channel checks resolve an ID in Rust.

Channel switches use a durable `release-channel-state.json` plus a monotonic
`release-store-marker.json` in app data. The marker advances to the running
build's write epoch before Berd opens its layout database. A target release must
carry `signedCompatibility`, signed by that channel's updater key and bound to
channel ID, version, archive SHA-256, and readable/write epochs. Rust verifies
the descriptor, downloads and updater-verifies the archive, checks its SHA-256,
and only then installs it. An incompatible target stops intake from the old
feed and waits on the selected feed without running older code over newer data.

Catalogs containing `beta` require `beta_linear_label_id` (a Linear label UUID)
at build time. Beta reports reuse Berd's feedback dialog, include the running
version/channel in the ticket title and description, and attach that label.
Main/Beta activation remains subject to the release lane's non-promoting signed
rehearsal and promotion approvals.
