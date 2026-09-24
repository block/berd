# Encrypted memory implementation

The encryption implementation is draft PR #347, originally based on memory PR #290 at `7aa3392ea272d058af9a2390dbfdc8452ce46a50`. The follow-up has passed local integration validation; signed native acceptance and rollout decisions remain open. Validation results belong in the handoff report, not inferred from this design.

## Platform availability

The first supported target is Apple-silicon macOS (`aarch64-apple-darwin`). Memory availability is a compiled-platform boundary, separate from the person's explicit memory policy. The target gate applies to commands, storage, MCP startup, renderer callers, and resolved packaging. Windows, Linux, and Intel Mac builds must not operate Berd memory. They leave existing memory files and credentials unchanged; a stale enabled policy or dev override must not activate it.

Frontend platform labels and browser user agents are not security boundaries. Native target gates remain authoritative even if renderer calls are forced. The absence guarantee covers Berd's memory subsystem and managed MCP registration, not arbitrary user-installed tools or older binaries launched separately. Keep normal Windows/Linux CI and tests for feature absence. An explicit `portable-store` crate feature exercises the shared store and standalone MCP on Intel Mac, Linux, and Windows without opening desktop/package gates. Linux directory-sync and Windows contention repairs are included; Linux runtime and Windows cross-compilation passed, but Windows execution and real credential access remain unverified. See [portability scope](memory-portability.md).

## Boundary

Berd encrypts active memory documents, pending proposals, suppression records, and approval metadata. People edit memory in Berd and explicitly import or export Markdown. Imports are reviewed before saving. Exports are plaintext.

This protects copied store contents when the reader lacks the key. It does not establish isolation from all processes running as the person, or protect a compromised Berd process. Recalled memory and preambles enter agent context; harness transcripts and provider-side retention are separate boundaries. Historical plaintext backups and exports remain outside the encrypted store.

Topic filenames, file sizes, and policy state remain visible. Suppression retains fingerprints, not original declined facts, even inside encryption.

## Storage and keys

The shared `berd-memory` crate owns authenticated encryption and memory record access. The app and bundled MCP sidecar share the storage reader. The app initializes a new store explicitly; the sidecar never initializes or replaces keys. Keys remain outside renderer IPC, child arguments, configuration files, and environment variables. A local synthetic macOS probe could create/read a key in its parent process, but its separately named reader timed out. Cleanup was verified. Shared native key access is therefore not established; see [native probe results](native-memory-key-probe.md).

OS-keystore availability and authorization depend on platform and session. The pinned macOS backend uses legacy generic-password Keychain operations, not an explicit Berd trusted-app list or access group. Same service/account selects an entry; same team/bundle identity alone does not prove sidecar authorization. Missing, denied, locked, malformed, or unavailable keys must not become an empty store or trigger plaintext writes. See the [native acceptance procedure](memory-macos-acceptance.md) for required evidence and isolation.

Pending credential authorization does not hold the transaction/policy lock.
Initializers use a separate persistent lock; established opens revalidate the
root identity and markers after key lookup. Blocking app commands run on worker
threads with bounded outstanding key operations, while policy-off remains
key-worker-independent. Synthetic paused-provider and caller tests cover these
properties. This does not establish a deadline or cancellation for native
Keychain calls, or signed app/sidecar interoperability.

Writers validate and normalize plaintext before encrypting. Approval metadata is authenticated and encrypted. Pending proposals remain non-recallable. Ciphertext is bound to its record identity, and temporary files contain ciphertext only. Multi-step approval and suppression changes use one writer lock and preserve retry safety.

## Existing installations

The initial local implementation refuses legacy plaintext stores rather than migrating during reads or silently deleting files. Do not point an ordinary development run at a real person's memory store for testing.

Before release, establish whether people already have memory to migrate. If so, a deliberate migration must cover documents, queue, suppression, and approval state, with interrupted-operation recovery. Do not automatically approve legacy content or leave new plaintext backups. Deleting files cannot promise removal from SSD history, snapshots, or backups.

Key loss is not silently repaired. A backup of ciphertext alone is insufficient to recover memory without the key. No recovery key, machine-transfer, destructive reset, or authenticated-snapshot rollback detection is implemented. Accept those limitations explicitly or implement the required behavior before broad release.

Older plaintext writers do not honor the encrypted store marker or lock. They can overwrite encrypted documents, approvals, and queues. New version checks cannot restrain already-installed older development binaries. Same-root downgrade safety is therefore not established: a version/launch restriction, root isolation, or an explicitly accepted rollout limitation must be chosen. Refusing legacy data is not a migration, and preserving files is not sufficient if supported testers require continued in-app access.

## Packaging acceptance

Tests with injected keys establish storage behavior, not OS authorization. Test the actual signed app and bundled sidecar together before claiming release readiness:

1. Use an isolated OS account or VM and synthetic content.
2. Have the app initialize a new store; confirm the bundled sidecar recalls approved content and excludes pending content.
3. Relaunch, then update the app and sidecar together; confirm the same key remains accessible.
4. Deny/cancel credential prompts and make the credential service unavailable; confirm errors, no replacement key, no plaintext fallback, and a working memory-off switch.
5. Run the supported Apple-silicon macOS lifecycle matrix on the final candidate. Windows/Linux/Intel acceptance for this release proves absence of the feature, sidecar, and memory requests; native credential-service support is deferred. Metadata inspection and a local debug binary are not substitutes for signed Mac acceptance.
6. If an earlier signed run is used to choose shared-Keychain versus app-broker architecture, rerun acceptance after any subsequent storage, migration, sidecar, or packaging changes. Do not use the public release workflow solely to obtain a signing probe: it stages release assets. Use an approved non-publishing artifact path.

A synthetic credential probe, if used, must have a unique service/account namespace, never enumerate or touch production entries, never output the secret, and verify cleanup. Do not automate approving keychain prompts.

## Delivery

Keep the change on one branch based on #290 for review: splitting encryption across mergeable partial changes would temporarily break readers or leave queues plaintext. The stack owner can take the final integration patch and fold the storage/UI, review-queue, and MCP hunks into #288, #289, and #290 respectively, or retain a single follow-up commit on top of the stack.

The law change is part of that review: direct plaintext file interoperability becomes explicit Markdown portability. The code should not be presented as preserving live direct file editing.
