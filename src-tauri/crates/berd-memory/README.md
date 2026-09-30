# Berd encrypted memory crate

This crate implements the proposed encrypted store shared by Berd and its memory MCP sidecar. The desktop command/storage integration is supported only on Apple-silicon macOS (`aarch64-apple-darwin`). The main app calls `MemoryStore::initialize` explicitly; the sidecar calls `MemoryStore::open` and never creates or replaces a key. `MemoryStore::with_key` is for isolated tests and never accesses Keychain. See [the design and unresolved release decisions](../../../docs/memory-encryption.md).

## Storage contract

Encrypted logical records are `me.md`, `topics/*.md`, `proposals/pending.jsonl`, `proposals/dismissed.jsonl`, and `.approved-content.json`. The extensions do **not** indicate plaintext files. The OS key is outside renderer IPC, agent arguments, and environment variables. Authenticated encryption binds ciphertext to the store identifier, record kind and relative path; write temporaries and the recovery journal contain ciphertext only. Filenames, sizes, timestamps, format markers, and `policy.json` are visible.

- `open(&Path)` requires an established marker and existing key; missing, invalid, or unavailable keys cannot replace a store. `initialize(&Path)` starts an empty store or resumes an interrupted initialization only when its marker and key match. Neither accepts legacy plaintext as an empty store.
- `read`, `write`, `records`, and approval methods use logical relative paths; callers hold `store.lock()` across reads and mutations. Store methods do not reacquire the lock. `lock()` finishes an authenticated pending transaction before returning; after a transaction error, release and reacquire the lock for recovery before continuing.
- `commit_records` and `commit_reviewed_document` use an encrypted bounded journal so a reviewed document, its approval digest, and the complete dismissed/suppression queue recover together. Pending-proposal removal is a final idempotent caller step. Corrupt or conflicting journals block access instead of silently resetting data. This is consistency for cooperating locked readers, not a filesystem-wide atomic rename.
- `policy_enabled` checks separate non-sensitive `policy.json` and fails closed on malformed data. Policy writes use the directory lock without needing Keychain. Key lookup does not hold this transaction/policy lock; initialization uses a separate persistent lock, and established opens revalidate identity and markers after Keychain returns. App memory commands offload blocking key calls to bounded workers so the off switch is not starved by a pending credential prompt. Native OS calls themselves have no deadline or cancellation.
- The key service/account is `com.block.berd.memory.active.v1` / `active-store-<UUID>`. Same service/account is **not** proof of signed app/sidecar authorization. No recovery key or automatic plaintext migration exists; see the design doc before enabling this for an existing store.

Capability-relative no-follow access protects roots, parents, files, journal and locks from symlink swaps. Authenticated bytes reject wrong keys, tampering, truncation, record swaps and cross-store reuse. The format does not detect rollback of a whole authenticated snapshot. Older plaintext writers are outside this protocol and may damage the same-root store.

## Tests

After activating Hermit, run `cargo test -p berd-memory` and `cargo clippy -p berd-memory --all-targets -- -D warnings` from `src-tauri/`. Unit tests use temporary roots and injected keys/fake providers, not real Keychain. Test coverage includes partial initialization and retry, policy-off during blocked lookups, multi-record transaction recovery, permissions and paths, legacy refusal, encrypted queues/approvals, and MCP recall-policy enforcement. A subprocess test exercises the production stdio executable only with an isolated HOME and missing marker, before Keychain access.

These tests are not a substitute for a signed app + bundled sidecar acceptance run on an isolated macOS account. The review candidate deliberately does not include the former `portable-store` feature, Windows/Linux native credential support, or portability-test claims.
