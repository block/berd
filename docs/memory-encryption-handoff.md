# Memory encryption handoff

## Status and stack

Draft #347 extends memory MCP #290 (`clay/memory-mcp`); it does not replace
foundation #288 or reviewed-proposals #289. The follow-up branch includes the
attributable #348 voice-catalog repair and main at `2f93fb34`, matching the tested
integration. The owner branches are unchanged; later stack refresh remains
coordinated with their owner. This is not a claim of validation against the
latest main.

**Full local integration validation passed. Keep the PR draft.** Default desktop
memory availability remains Apple-silicon macOS. The `portable-store` feature
validates the shared encrypted store/MCP on Intel Mac, Linux, and Windows without
enabling those desktop commands, UI, managed registration, or packages. Actual
signed app/sidecar key access and rollout decisions remain open.

## What changed

- Authenticated encryption for documents, pending proposals, suppression
  fingerprints, approval metadata, and transaction journals.
- Explicit, retryable key initialization; established missing keys never
  regenerate. No plaintext fallback or automatic legacy migration.
- Pending key authorization does not hold the policy/transaction lock.
  Initialization is separately serialized and root/markers are revalidated
  before recovery/publication. Blocking app operations use bounded workers;
  cancelled async waiters do not pretend to cancel native credential calls.
- Policy-gated approved recall and read-only MCP. Repeated memory-off transitions
  reach external harnesses; unapproved/private content remains excluded.
- In-app editing and explicit Markdown import/export. Import is an unsaved
  review draft; export warns that the selected file is plaintext.
- Compiled-target availability enforced through native, frontend, MCP, and
  packaging paths, including stale settings and managed config fragments.
- Linux directory-sync repair, Windows contention classification, retained-handle
  identity checks, and opt-in portable-store validation with real key backends.
- A read-only signature-inspection helper and native acceptance procedure.
  Signature metadata does not prove key authorization.

## Validation

The implementation snapshot passed the full repository `just ci` gate on
September 24, 2026. Reconstruction of the PR branch matched all 2,617 recorded
source entries; subsequent documentation updates reconcile this report. Raw
logs, session data, and local machine paths are not included in the repository.

| Check | Result |
|---|---|
| Full frontend suite | 7,962 passed, one skipped, across 652 files |
| Release-script suite | 214 passed |
| Configured Rust test lanes | 267 passed, one ignored across invocations |
| Shared-store/MCP/stdio on Apple-silicon Mac | 47 + 20 + 1 passed |
| Memory commands within full CI | 32 passed |
| Broader focused app-memory filter | 45 passed, including resolver/config tests |
| Frontend/Rust formatting, lint, i18n, typecheck | Passed |
| Tauri-check and configured clippy variants | Passed |
| Frontend production build | Passed |
| Intel-target runtime under Rosetta | 68 portable tests passed; disabled-target tests also passed |
| Isolated Linux arm64 runtime | 68 portable tests passed; disabled-target tests also passed |
| Windows GNU check and clippy | Default/portable compilation passed; no Windows runtime execution |
| Portable crate clippy on Mac/Linux | Passed with warnings denied |

The Rust lanes are those configured by `just ci`, not an unfiltered test of every
app module. Existing ignored/skipped tests were not newly disabled for this work.
Non-fatal test-build and frontend bundler warnings remain. Generic frontend
build success does not establish native packaging or signed acceptance.

Data tests use synthetic temporary stores/injected keys. Linux tests ran in a
local container with networking disabled, no host-home mounts, and no credential
service. The VM was stopped afterward. Windows protocol unit tests inject a
store; the HOME-isolated subprocess test is Unix-only because Windows Known
Folder discovery does not honor that isolation.

Earlier revisions had voice-catalog failures, Linux `EBADF` directory-sync
failures, Windows lock-contention failures, and a missing Sherpa native cache
library. The catalog/cache repairs are integrated, Linux runtime regression now
passes, and Windows source repairs compile. Windows runtime behavior still needs
native verification; no claim is made that cross-compilation closes it.

Prior UI validation used synthetic fixtures for edit/save, unsaved import,
export confirmation/cancel, and unavailable routes. Native pickers and real
credential prompts still require acceptance. Narrow reviews are not an
independent approval of the complete final change.

## Before merge or release

1. **Signed native key access:** test the actual app and bundled sidecar in an
   isolated interactive account, including pending/denied authorization, off,
   relaunch, update, unavailable credentials, and missing keys. The historical
   debug reader timed out; its cause is unknown. Use an approved non-publishing
   artifact path, not the release workflow merely to obtain a probe.
2. **Existing-data rollout:** determine whether draft users need migration.
   Legacy stores are preserved but refused. No recovery key, transfer, or
   destructive reset flow is provided.
3. **Platform promotion:** retain ordinary Windows/Linux CI and disabled-target
   tests. Native Windows/MSVC, Linux Secret Service, Intel hardware/package, and
   full desktop registration/UI/package acceptance must precede opening those
   platform gates. See [portability](memory-portability.md).
4. **Threat boundary:** filenames/sizes/policy remain visible; exports, historical
   backups, transcripts, and compromised/same-user processes are outside the
   encryption claim. Complete authenticated rollback is undetected. Older
   plaintext writers can damage the same-root encrypted store. Select and
   document the accepted rollout controls/limitations.
5. **Existing security review:** confirm #290's executable-pathjacking requirement
   with its owner. Hardened resolution does not guarantee immunity from later
   bundle replacement. Markdown import hardening does not close that finding.
6. **Native import/export:** verify review-before-save, cancel, plaintext warning,
   and destination behavior. No picker-time identity, immutable snapshot, or
   general I/O deadline is promised.
7. **Published candidate:** keep DCO and code-owner review requirements, verify CI
   on the actual PR head, and coordinate any subsequent stack/base changes.

Encryption and the lower memory layers must reach users as one release unit.
The owner may retain the coherent follow-up or fold its hunks into the lower
stack; do not ship partially encrypted readers/writers or plaintext queues.
