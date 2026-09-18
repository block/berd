# Encrypted memory implementation

Local implementation based on the memory stack through #290, commit `7aa3392ea272d058af9a2390dbfdc8452ce46a50`. Not published. Validation results belong in the handoff report, not inferred from this design.

## Boundary

Berd encrypts active memory documents, pending proposals, suppression records, and approval metadata. People edit memory in Berd and explicitly import or export Markdown. Imports are reviewed before saving. Exports are plaintext.

This protects copied store contents when the reader lacks the key. It does not establish isolation from all processes running as the person, or protect a compromised Berd process. Recalled memory and preambles enter agent context; harness transcripts and provider-side retention are separate boundaries. Historical plaintext backups and exports remain outside the encrypted store.

Topic filenames, file sizes, and policy state remain visible. Suppression retains fingerprints, not original declined facts, even inside encryption.

## Storage and keys

The shared `berd-memory` crate owns authenticated encryption and memory record access. The app and bundled MCP sidecar share the storage reader. The app initializes a new store explicitly; the sidecar never initializes or replaces keys. Keys remain outside renderer IPC, child arguments, configuration files, and environment variables. A local synthetic macOS probe could create/read a key in its parent process, but its separately named reader timed out. Cleanup was verified. Shared native key access is therefore not established; see [native probe results](native-memory-key-probe.md).

OS-keystore availability and authorization depend on platform and session. The wrapper does not establish a Berd-only access-control list. Missing, denied, locked, malformed, or unavailable keys must not become an empty store or trigger plaintext writes.

Writers validate and normalize plaintext before encrypting. Approval metadata is authenticated and encrypted. Pending proposals remain non-recallable. Ciphertext is bound to its record identity, and temporary files contain ciphertext only. Multi-step approval and suppression changes use one writer lock and preserve retry safety.

## Existing installations

The initial local implementation refuses legacy plaintext stores rather than migrating during reads or silently deleting files. Do not point an ordinary development run at a real person's memory store for testing.

Before release, establish whether people already have memory to migrate. If so, a deliberate migration must cover documents, queue, suppression, and approval state, with interrupted-operation recovery. Do not automatically approve legacy content or leave new plaintext backups. Deleting files cannot promise removal from SSD history, snapshots, or backups.

Key loss is not silently repaired. A backup of ciphertext alone is insufficient to recover memory without the key. Recovery, machine transfer, rollback to older plaintext writers, and any destructive reset need explicit product behavior before broad release.

## Packaging acceptance

Tests with injected keys establish storage behavior, not OS authorization. Test the actual signed app and bundled sidecar together before claiming release readiness:

1. Use an isolated OS account or VM and synthetic content.
2. Have the app initialize a new store; confirm the bundled sidecar recalls approved content and excludes pending content.
3. Relaunch, then update the app and sidecar together; confirm the same key remains accessible.
4. Deny/cancel credential prompts and make the credential service unavailable; confirm errors, no replacement key, no plaintext fallback, and a working memory-off switch.
5. Test macOS, Windows, and supported Linux desktop credential services. Metadata inspection and a local debug binary are not substitutes.

A synthetic credential probe, if used, must have a unique service/account namespace, never enumerate or touch production entries, never output the secret, and verify cleanup. Do not automate approving keychain prompts.

## Delivery

Keep the change on one branch based on #290 for review: splitting encryption across mergeable partial changes would temporarily break readers or leave queues plaintext. The stack owner can take the final integration patch and fold the storage/UI, review-queue, and MCP hunks into #288, #289, and #290 respectively, or retain a single follow-up commit on top of the stack.

The law change is part of that review: direct plaintext file interoperability becomes explicit Markdown portability. The code should not be presented as preserving live direct file editing.
