# Memory encryption handoff

## Status

Encryption is published as draft PR #347, originally based on memory PR #290 at `7aa3392ea272d058af9a2390dbfdc8452ce46a50`. Draft #348 separately repairs the voice catalog regression in #289. A local macOS-first integration brings current main and the catalog repair together without rewriting the stack owner's branches.

**Implementation in progress; keep draft.** This follow-up limits memory to Apple-silicon macOS, with absence checks on Windows, Linux, and Intel Mac. Native signed app/sidecar key access, final integrated validation, security review, and the existing-data/recovery rollout decisions remain open. The test table below records the earlier encryption revision, not completed validation of this follow-up.

## What changed

- Shared authenticated encryption for active documents, pending proposals, suppression fingerprints, approval metadata, and transaction journals.
- OS-keystore key management with explicit, retriable initialization; established missing keys never regenerate.
- Cross-process locking and recoverable encrypted transactions for document/approval/deletion-suppression changes.
- Memory-specific UI reads and policy-gated approved recall snapshots; MCP reads the encrypted store and never creates keys.
- Explicit Markdown import into an unsaved review draft; plaintext export behind a warning and native picker.
- Backend normalization, credential rejection, strict policy schema, no-follow storage access, and no corrupted-data-as-empty fallback.
- Memory-specific Rust tests and a corrected MCP binary target name. The original change staged Linux memory too; the macOS-first follow-up removes unsupported-target runtime/packaging and tests its absence.
- Product-law update: editable in Berd and portable as Markdown, rather than live plaintext-file editing.

## Validation

All data tests use synthetic fixtures. No live memory files or production credential entries were accessed. Native probe scope is described separately.

| Check | Result |
|---|---|
| Shared storage, MCP and stdio tests | 55 passed |
| Tauri memory command tests | 29 passed |
| Frontend memory tests, including initialization retry | 113 passed |
| `just check` | Passed |
| Frontend production build | Passed |
| `just tauri-check` | Passed, including app features and berdctl |
| Rust formatting and whitespace checks | Passed |
| `just clippy` | Passed with warnings denied, including app feature variants, memory crate/tests, CLI and broker |
| Release-script suite | 104 passed |
| Final full frontend suite | 7,912 passed, 14 failed, 1 skipped; all 14 failing test names exactly match the initial voice-settings failures. |
| Release-mode MCP staging | Passed on aarch64 macOS |
| Staged release MCP smoke | Initialize, two read-only tools, policy-off rejection passed in an isolated HOME; no store files created |
| UI browser fixture | Import does not write; explicit Save makes one atomic save IPC. Export warning and cancel verified. Native pickers mocked. |
| Independent final source review | No new high-confidence actionable findings; not a substitute for platform/security acceptance |
| Native keychain probe | Parent create/read passed; separate reader timed out. Exact synthetic entry deleted and confirmed absent. Shared access is NOT established. |

Full local `just ci` stopped at the voice failures after the preceding gates passed. Those failures were later traced to #289's changed/missing voice translations, not current main; #348 fixes the catalog. Release-script tests and the frontend build passed separately, not within that stopped CI invocation.

The published encryption revision then exposed Linux `EBADF` publication failures and Windows lock-related failures in CI. These remain deferred unsupported-platform defects, not fixed findings. In macOS CI, all shared memory/MCP tests passed before the broader app test build failed on missing `sherpa-onnx-c-api`. The macOS-first follow-up must clear full applicable CI and prove absence on excluded targets. Raw local logs are not included in the shareable package.

## Before merge

1. **Resolve native key access using actual signed app and bundled sidecar.** The local debug probe did not prove interoperability. Test prompts, denial, relaunch, update, and unavailable credentials. If shared access is unreliable or unacceptable, have the app serve approved recall to the sidecar over authenticated local IPC. That broker is not implemented here.
2. **Decide existing-data rollout.** Legacy plaintext stores are refused, left untouched. If testers/users already have memory, add an explicit migration covering documents, proposals, suppression, and approval state. No silent reset or automatic approval. No key recovery/transfer flow is claimed.
3. **Prove the target boundary and final Mac behavior.** Only Apple-silicon macOS supports memory. Windows, Linux, and Intel Mac must have no memory command dispatch, managed sidecar startup, store/key access, or background requests, including stale enabled settings and old app-managed MCP fragments. Keep ordinary Windows/Linux CI. Actual signed Mac lifecycle acceptance is still required.
4. **Keep the threat boundary honest.** Topic filenames and file sizes are visible. Exports, historical backups, and agent transcripts are outside encrypted storage. No complete same-user isolation or authenticated-snapshot rollback protection is claimed. Old plaintext writers can damage the same-root encrypted store; select a downgrade policy before rollout.
5. **Close the actual #290 executable-pathjacking finding.** The unresolved review at https://github.com/block/berd/pull/290#discussion_r3929898945 concerns sidecar executable resolution, not Markdown import. Confirm the hardened resolver and Mac-only runtime meet the agreed threat requirement, with a targeted regression. An outdated thread is not a closed finding.
6. **Validate import separately.** Import uses a parent directory capability, no-follow leaf opening, descriptor validation, bounded UTF-8 reads, and nonblocking Unix opens. Tests must exercise native Mac import/cancel/review behavior. The implementation does not promise picker-time file identity, an immutable snapshot, or a general I/O deadline.

If encryption is required for launch, treat the four-PR sequence as one release unit. Do not ship the lower memory layers without encryption merely because those PRs merge first.

## Best delivery path

Offer the stack owner a draft integration PR based on `clay/memory-mcp` (#290), keeping all readers and writers together. Do not submit it as a competing replacement for the stack or mix in the abandoned prototype. Include this test table, screenshots, and the native keychain result in the PR body.

The stack owner can review the coherent patch first, then either keep one follow-up commit or fold the storage/UI changes into #288, queue changes into #289, and recall changes into #290. Splitting into independently mergeable partial encryption commits would leave broken readers or unencrypted queues.
