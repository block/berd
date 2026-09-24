# Encrypted memory store

`store::MemoryStore` is the shared persistence boundary for Berd and the memory
MCP sidecar. The app explicitly calls `initialize`; the sidecar only calls
`open`. Neither method reads legacy plaintext records. Existing plaintext stores
need an explicit migration that is **not implemented** here.

The default desktop availability remains Apple-silicon macOS. For local native
validation, `--features portable-store` enables this crate's encrypted store and
MCP on Intel macOS, Windows, and Linux with their OS key backends. It does not
enable the app or release packaging. See [portability status and commands](../../../../docs/memory-portability.md)
for the test matrix and remaining acceptance requirements.

## API and locking

- `open(&Path)` requires an initialized store and its existing OS key.
- `initialize(&Path)` initializes an empty store, retries an interrupted empty
  initialization, or opens an initialized store.
- `with_key(&Path, [u8; 32])` initializes/opens an isolated store using only the
  supplied key. It never accesses the OS keychain.
- `is_uninitialized(&Path) -> Result<bool, String>` inspects freshness without
  accessing keys. Missing/empty roots, policy-only roots, and empty
  `topics`/`proposals` directories are fresh. Established or explicitly
  initializing stores return false. Legacy data, ciphertext, or temporary files
  without the established marker produce an error, not an empty list. This
  method briefly acquires the directory lock; do not call under another lock.
- `root`, `read`, `write`, `records`, `write_records`, `append_record`,
  `mark_approved`, `is_approved`, `document_paths`, and `lock` operate on logical
  record paths. Low-level `write`/`mark_approved` are not a reviewed-save API.
- `commit_records(&[(&str, String)]) -> Result<(), String>` commits replacements
  of allowlisted logical records using an encrypted recovery journal.
- `commit_reviewed_document(relative: &str, contents: &str, create_new: bool,
  dismissed: Option<&[Value]>) -> Result<(), String>` commits the document,
  approval digest, and optional **complete** dismissed/suppression queue
  together. It normalizes document text and rejects credentials. `create_new`
  requires an absent document; edits require an existing document. Pending
  proposal removal is deliberately left to the caller as a final idempotent
  step. Callers still apply their product-specific admission and size rules.
- `acquire_store_lock(&Path)` permits policy changes without needing a key.
- `policy_enabled(&Path)` reads the separate, non-sensitive policy, failing
  closed. Its only allowed field is the required boolean `enabled`; unknown
  fields, duplicate fields, and malformed values are rejected.

Callers hold `store.lock()` across reads and mutations, including an entire
multi-record snapshot or read-modify-write operation. Methods do not reacquire
it. The transaction methods enforce that the current thread holds a lock from
that same store instance (a guard from `acquire_store_lock` is insufficient).
`lock()` recovers any pending transaction **before** returning the guard. Open
and initialization also recover under their own temporary locks, so
initialize/open **before** taking a transaction lock. After a transaction error,
release and reacquire the lock: the journal may already have committed the
operation and recovery must finish it. Reads and ordinary mutations refuse to
proceed while any journal remains. Never treat a transaction error as proof
that no change committed.

Credential lookup and creation run without the transaction/policy lock. An
established open snapshots both markers under that lock, requests its existing
key unlocked, then rechecks the root directory identity and both markers before
verification or recovery. Initialization holds a separate
`.berd-memory-init.lock` across credential calls, taking the transaction lock
only for inspection and publication. Initializers always take the initialization
lock first; policy writes never take it. Freshness is rechecked before final
publication, and established missing keys still cannot be replaced.

Lock files are persistent; they must not be deleted on a timer or on release.
OS advisory locks serialize cooperating app and MCP processes using this
protocol and are released on process exit. Non-cooperating filesystem writers
and older binaries that do not implement this protocol are outside that guarantee.
The app runs blocking memory I/O off synchronous command dispatch, with at most
four outstanding key-access workers. Cancelling an async waiter does not cancel
a native call or free its worker permit. Policy writes and off-state recall/
proposal results do not require a key-worker permit. This preserves the off
switch during pending key authorization; it does not impose a Keychain deadline
or prove native prompt behavior.

## Storage format and recovery

Allowed encrypted records are `me.md`, `topics/*.md`,
`proposals/pending.jsonl`, `proposals/dismissed.jsonl`, and
`.approved-content.json`. These logical names contain binary ciphertext, not
Markdown or JSON. Editing/import/export is through Berd.

Every record uses AES-256-GCM with a fresh random 96-bit nonce and authentication
of the format version, random store identity, record type, and relative path.
Records are limited to 8 MiB of UTF-8 plaintext. Ciphertext has an eight-byte
`BERDMEM\x01` header, the nonce, ciphertext, and authentication tag. Only
ciphertext is written to record temporary files. Replacement is atomic;
create-new publication uses a hard link and fails without overwriting if the
target exists. Filesystems without hard-link support fail closed for create-new
writes. Unix file/directory syncs make the journal precede record publication
and journal removal follow all record publications. Windows retains atomic file
publication but does not have the Unix directory-fsync durability guarantee.

`.berd-memory-transaction` contains only authenticated ciphertext, bound to the
store identity and a distinct transaction type/path. The decrypted journal has
a strict versioned schema, at most 64 unique allowlisted records, bounded
bodies, and authenticated previous-content hashes. The entire encoded journal
is limited to 32 MiB (including JSON escaping), and each record retains its
8 MiB limit. Queues and approval manifests are structurally validated before
publication and recovery. Recovery authenticates all affected existing records
before replay, accepts only the recorded prior or intended new value, applies
each file idempotently, and removes the journal last. Corrupt, conflicting,
oversized, or malformed journals block access; they are never discarded to
reset the store. This is recoverable multi-file consistency for locked readers,
not a filesystem-wide atomic rename.

`.berd-memory-store.json` is the established non-sensitive version/identity
marker with an authenticated key-verification proof. Initialization first saves
`.berd-memory-initializing.json` with the proposed identity/proof, then creates
the OS key, then publishes the established marker and removes the initialization
marker. A cancelled or failed key creation can be retried. If key creation
reported an error after saving the key, retry verifies the saved key against
the proof and finishes without replacing it. A missing key may be created only
for a fresh store or an explicit initialization state with **no** records,
ciphertext temporaries, or transaction journal. Missing keys for established
stores are never regenerated, even when the store has no documents. Invalid
proofs and conflicting markers are errors. Unrecognized orphan temporaries
from an interrupted initial marker publication fail closed and require explicit
recovery; they are not automatically deleted or treated as a fresh store.

The keyring service is `com.block.berd.memory.active.v1`, with account
`active-store-<store UUID>`. These names are separate from the abandoned prototype.
Native storage and the MCP executable are active only on Apple-silicon macOS;
Windows, Linux, and Intel Mac builds exclude them. The active backend is macOS
Keychain. Signed app/sidecar authorization, prompts, relaunch, and upgrades still
need isolated native acceptance; automated tests do not access a real keychain.
Unsupported-platform memory defects remain deferred, not fixed by this gate.

Capability-relative directory/file operations reject symlink roots, record
parents, files, journals, and locks. No-follow operations retain directory
handles through reads and ciphertext publication. Approval metadata and
suppression records are encrypted; filenames, sizes, timestamps, format and
initialization markers, and `policy.json` are not.

This protects stored content without its key, not against a process already able
to read the user's keychain or decrypted process memory. It does not provide
rollback detection against restoration of a complete older authenticated snapshot.
Explicit plaintext exports, old plaintext backups, and agent transcripts are
outside the encrypted-store boundary.

## Tests

Run `cargo test -p berd-memory` and
`cargo clippy -p berd-memory --all-targets -- -D warnings` after activating
Hermit. Tests use temporary roots, injected keys, and an in-memory key provider;
they never access the real memory store or OS keychain. Coverage includes
failed/partial key creation and retry, crashes between key/marker publication,
interruption at every transaction commit point for creates and edits, recovery
through every constructor and `lock`, corrupt/conflicting journals, plaintext
absence, path/store swaps, missing keys, initialization races, cross-process
locking, atomic create-new races, symlink rejection, legacy refusal, strict
policy schema, encrypted approval/queue metadata, and MCP policy/approval
enforcement. Channel-paused credential tests cover policy-off during established
lookup, initialization lookup and creation, concurrent initializers, and state
changes before publication. App/MCP tests cover recall and proposal policy
rechecks after paused opens; app tests cover bounded workers, cancellation, and
off-state behavior with all key workers occupied. Encrypted recall is tested
through the newline protocol with an injected store. A Unix subprocess test exercises the production stdio binary
with an isolated HOME and a missing marker (before keychain access).
