# Memory encryption handoff

## Status

Implemented locally, based on memory PR #290 head `7aa3392ea272d058af9a2390dbfdc8452ce46a50`. The remote head was rechecked and still matched during validation. No push, PR, or comment has been made.

**Ready for code review, not a merge-ready security claim.** Native shared key access, supported-platform acceptance, and the existing-data rollout decision remain open.

## What changed

- Shared authenticated encryption for active documents, pending proposals, suppression fingerprints, approval metadata, and transaction journals.
- OS-keystore key management with explicit, retriable initialization; established missing keys never regenerate.
- Cross-process locking and recoverable encrypted transactions for document/approval/deletion-suppression changes.
- Memory-specific UI reads and policy-gated approved recall snapshots; MCP reads the encrypted store and never creates keys.
- Explicit Markdown import into an unsaved review draft; plaintext export behind a warning and native picker.
- Backend normalization, credential rejection, strict policy schema, no-follow storage access, and no corrupted-data-as-empty fallback.
- Memory-specific Rust tests added to local/CI recipes, corrected MCP binary target name, and Linux release sidecar staging.
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

Full `just ci` stopped at the known frontend failures after the preceding gates passed. Release-script tests and the frontend build passed separately, not within that stopped CI invocation. Raw local logs are not included in the shareable package.

## Before merge

1. **Resolve native key access using actual signed app and bundled sidecar.** The local debug probe did not prove interoperability. Test prompts, denial, relaunch, update, and unavailable credentials. If shared access is unreliable or unacceptable, have the app serve approved recall to the sidecar over authenticated local IPC. That broker is not implemented here.
2. **Decide existing-data rollout.** Legacy plaintext stores are refused, left untouched. If testers/users already have memory, add an explicit migration covering documents, proposals, suppression, and approval state. No silent reset or automatic approval. No key recovery/transfer flow is claimed.
3. **Run Windows and Linux native acceptance.** Code paths and CI wiring exist; this work ran on macOS. Cross-platform credential services, replacement semantics, and power-loss durability are not established by simulated tests.
4. **Keep the threat boundary honest.** Topic filenames and file sizes are visible. Exports, historical backups, and agent transcripts are outside encrypted storage. No complete same-user isolation or rollback protection is claimed.

5. **Confirm the reported import-race finding.** Follow-up source review found a pathname precheck/open gap. Import now uses a parent directory capability, no-follow leaf opening, descriptor validation, and bounded reads; Unix opens also request nonblocking behavior. Synthetic tests cover file types, bounds, encoding, and deferred UI imports. This addresses the observed source weakness, but the original review's full finding is still needed to confirm closure. Windows native behavior and exact picker-time file identity are not guaranteed by these tests.

If encryption is required for launch, treat the four-PR sequence as one release unit. Do not ship the lower memory layers without encryption merely because those PRs merge first.

## Best delivery path

Offer the stack owner a draft integration PR based on `clay/memory-mcp` (#290), keeping all readers and writers together. Do not submit it as a competing replacement for the stack or mix in the abandoned prototype. Include this test table, screenshots, and the native keychain result in the PR body.

The stack owner can review the coherent patch first, then either keep one follow-up commit or fold the storage/UI changes into #288, queue changes into #289, and recall changes into #290. Splitting into independently mergeable partial encryption commits would leave broken readers or unencrypted queues.
