# macOS memory acceptance

This is the release acceptance procedure, not a report of a successful native test. Keep the change in draft until the final candidate and rollout decisions pass the gates below.

## What is established

The shared store's injected-key tests exercise encryption, corruption, missing keys, locking, and recovery. They do not establish OS authorization between two executables. The historical debug probe timed out in its separate reader; its cause is unknown.

The pinned `keyring` macOS backend uses the user's default legacy Keychain with generic-password lookup/add/modify operations through `security-framework`. Berd supplies a service and store-specific account, not an explicit trusted-application list or access group. Selecting the same item does not prove permission for the separately signed MCP sidecar. Neither a matching TeamIdentifier nor adding an access-group entitlement alone demonstrates sharing for this backend.

The dependency's setter is an upsert. Berd serializes initialization with the store lock and verifies an existing key; this is not an atomic create-only Keychain primitive or a defense against malicious same-user processes.

## Artifact prerequisite

Ask the release maintainer for two release-equivalent signed test builds so that upgrade behavior can be exercised. For each, retain independently obtained source/build provenance and the expected app and sidecar signing identities. Use the supported Apple-silicon target, expected entitlements and bundle layout, and an updater-disabled acceptance profile.

Use an approved non-publishing signing lane. The normal release workflow creates/stages release assets and can reach promotion; it must not be triggered just to obtain a test artifact. Ad-hoc signing from the unsigned build workflow is not equivalent. Do not widen OIDC or signing permissions as a shortcut.

Before running either build:

1. Verify the artifact digest against the maintainer's authenticated evidence.
2. Verify the bundle signature and both the main executable and `Contents/MacOS/berd-memory-mcp` separately. Record identifiers, expected signing team/authority, designated requirements, architecture, and entitlements. Reject unsigned/ad-hoc or substituted payloads.
3. Check source provenance independently. A supplied source SHA or a digest computed from the same untrusted artifact does not prove origin.
4. Confirm the memory sidecar in the package is the one the app will resolve. Verify updater/distribution is disabled for this test.

The local signature-inspection helper checks artifact metadata only. Its passing report never replaces the interactive lifecycle test below. Existing generic app entitlement checks inspect only the main executable; the sidecar must be included in this acceptance.

Run `node scripts/release/inspect-memory-signatures.mjs --help` for its required inputs. Supply an absolute inspection root containing the signed archive and an already extracted, quiescent app, expected team and executable identifiers, independently verified SHA-256 digests for the archive and both executables, and the source SHA label. The helper does not extract archives, execute inspected binaries, sign code, or access Keychain. It returns sanitized JSON or a nonzero failure. It inspects archive and app independently; it does not itself prove that extraction produced that app or that the supplied source label is authentic. It is not part of automatic release promotion.

## Safe test environment

Use a disposable interactive macOS account or VM with no personal memory or production credentials. Redirecting HOME in a normal account is insufficient to isolate its Keychain. Use synthetic content and the actual packaged app/sidecar; do not add production key overrides through environment, arguments, config, or renderer IPC.

Record the exact test store identity and exact synthetic credential entry for cleanup without exposing the key. Do not enumerate credentials, automate prompt approval, export keys, or include memory content in diagnostics. Stop if isolation cannot be verified.

## Lifecycle matrix

| Scenario | Required observation |
|---|---|
| Fresh initialization from app | Explicit action creates one store and key; no ordinary reader initializes a store |
| App-approved document | UI reads it; actual bundled sidecar can recall approved content |
| Pending proposal/private notes | Neither is disclosed through recall; rejected credentials never persist |
| Memory off/on/off in a running session | Recall/proposals follow policy per operation; approving a proposal does not implicitly enable memory |
| Relaunch app and sidecar | Same established key; no replacement, prompt loop, or missing-state success |
| Log out/in or restart supported session | Established store remains usable according to documented Keychain authorization |
| Upgrade both app and sidecar | New signed versions access the existing key; record changed identities/requirements and prompts |
| Pending authorization | Keep the credential prompt unresolved while turning memory off; app stays responsive, off completes, and resumed recall/proposal calls disclose/save nothing while off. Repeated/cancelled requests cannot start unlimited key workers. Native calls may remain pending; do not claim async cancellation stops them. |
| Cancel/deny authorization | Safe error; no plaintext fallback, replacement key, or silent deletion |
| Locked/unavailable Keychain | Safe error; person can still turn memory off without key access |
| Delete only the synthetic established key | Store remains preserved and blocked; initialization cannot generate a replacement |
| Wrong key/corrupt record or marker | Authentication error, no empty-success state or automatic reset |
| Native Markdown picker/import/cancel/save | Import creates an unsaved review draft; cancel writes nothing; explicit Save commits reviewed content |
| Export | Plaintext warning and destination confirmation; active store/metadata cannot be overwritten |

No scenario passes merely because metadata or an injected test returned success. Use the first signed run to resolve architecture uncertainty; repeat on the final integrated candidate after storage, migration, sidecar, key-access, or packaging changes.

If app-created keys cannot be read reliably by the actual sidecar, stop and choose a supported authorization design or authenticated app broker. Do not broadly relax Keychain permissions or silently replace keys. A broker requires its own protocol/peer-authentication/policy-off acceptance before release.

## Rollout boundaries requiring decisions

- Legacy non-fresh stores are refused, not migrated. Record content must be preserved; refusal can create an advisory lock file, so whole-directory metadata identity is not the guarantee.
- No recovery-key, transfer, or destructive reset flow is provided. Ciphertext without its key is insufficient for recovery.
- The app's release data-epoch marker lives in app data; memory lives in a separate store and standalone MCP does not use that epoch. Catalog-free and older binaries can bypass app epoch handling. A new epoch cannot restrain every existing plaintext writer.
- Older plaintext writers can damage same-root ciphertext. Confirm the rollout excludes those writers or choose tested root isolation/launch restrictions. Do not implement a root move incidentally.
- Complete authenticated snapshot rollback is undetected. Restoring old records, approvals, suppression, and policy can resurrect removed content and an older enabled state. A counter restored with the snapshot would not solve this.
- Windows, Linux, and Intel Mac have no active memory feature in this release. Confirm whether any draft-build users need a transition that preserves in-app access; leaving files in place is not migration acceptance.

## Evidence and completion

For each scenario record candidate source SHA, artifact digests, supported OS/architecture, pass/fail/not-run, sanitized error category, and cleanup result. Keep detailed local evidence outside the repository; public handoff material excludes personal paths, run identifiers, raw session logs, secrets, and synthetic keys.

Verify cleanup of the exact synthetic credential and disposable test data. Do not report signed native acceptance complete until the final candidate passes and existing-data, downgrade, recovery, and rollback decisions are recorded. Release promotion is a separate approved action.
