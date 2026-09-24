# Cross-platform encrypted memory: local validation

The shared store and MCP have a local `portable-store` Cargo feature for Intel
macOS, Windows, and Linux. This enables the actual encrypted implementation and
platform credential backend in that crate, not a mock encryption path. It does
not enable desktop commands, UI, MCP registration, or release packaging on those
targets. Those gates remain closed pending native app/credential acceptance.
No runtime preference, environment key override, or plaintext fallback is added.

This replaces the earlier decision to defer all non-Apple-silicon work. It does
not mean all machines are now supported. A secure credential service and tested
filesystem behavior are prerequisites.

## Repairs

- Linux capability-directory descriptors can be `O_PATH` handles that reject
  `fsync`. Directory synchronization now opens a readable `.` relative to the
  pinned directory capability. Both ciphertext publication and journal/marker
  removal use this path; sync failures remain errors.
- Windows lock contention uses fs2's documented OS error as well as
  `WouldBlock`; ERROR_LOCK_VIOLATION no longer becomes an immediate generic
  failure. The five-second contention limit remains. Permission and other I/O
  failures are not retried as contention.
- Directory identity revalidation retains two live handles and compares them
  using `same-file`, replacing Unix-only identity code. Windows filesystem
  acceptance must establish the supported volume types; the dependency uses
  volume/file indices, not a universal identity proof for every filesystem.
- Synthetic ciphertext scans check that coordination files are empty without
  reading their locked byte ranges. Lock tests verify contention and subsequent
  acquisition on the same persistent file.
- The previous Keychain-wait correction remains: no credential call holds the
  transaction/policy lock, initialization is separately serialized, and missing
  established keys never regenerate.

On Windows, file contents are flushed and publication is atomic, but this patch
still does not establish the Unix directory-sync/power-loss durability guarantee.
Do not claim that all interrupted transactions survive arbitrary power loss.

## Key backends

| Platform | Backend | Required acceptance |
|---|---|---|
| macOS, either CPU | Keychain, apple-native | Actual signed app and MCP authorization, denial, relaunch, update |
| Windows | Credential Manager, windows-native | Native MSVC app/MCP execution, credentials under the same intended user context, denial/missing keys, update, locking/filesystem behavior |
| Linux | Secret Service, sync-secret-service with crypto-rust transport | Unlocked and locked service, missing service, actual app/MCP access in the intended login session, distribution/package behavior |

Linux without a usable Secret Service must report memory unavailable. It must
not store keys in a file, environment variable, or plaintext fallback. No
headless password/recovery-key mode is implemented by this change.

## Local commands

Activate the repository's Hermit environment first. The script uses locked,
offline Cargo resolution; prepare dependencies separately if necessary.

```sh
node scripts/test-memory-portability.mjs check x86_64-pc-windows-gnu
node scripts/test-memory-portability.mjs test x86_64-pc-windows-msvc
node scripts/test-memory-portability.mjs test x86_64-unknown-linux-gnu
node scripts/test-memory-portability.mjs test x86_64-apple-darwin
```

`check` cross-compiles all crate targets but does not link/run a Windows desktop
app. `test` requires the matching local OS/CPU; Apple-silicon macOS may run the
Intel suite through Rosetta if installed. The script first checks/tests the
ordinary disabled configuration, then the explicit `portable-store` variant.
It does not start a VM, credential service, desktop app, or release workflow.

Tests use temporary roots and injected keys. The actual stdio subprocess test
is Unix-only: Windows home discovery uses Known Folder APIs and does not honor
HOME/USERPROFILE test redirects. Windows MCP dispatch tests instead inject the
store directly. Do not remove that isolation guard to increase test counts.

## Current evidence and gaps

On September 24, Apple-silicon macOS, Intel macOS under Rosetta, and isolated
Linux arm64 execution each passed 47 shared-store/helper tests, 20 MCP tests,
and one stdio test. Linux and Intel's ordinary disabled builds each passed seven
helpers, two absence tests, and two compile-fail doctests. Windows GNU
cross-compilation passed both disabled and portable-store configurations,
including test code. Portable-store clippy passed with warnings denied on
macOS, Linux, and the Windows GNU target; the latter is cross-compilation, not
Windows execution.

The Linux test container had networking disabled, no host mounts, and no
D-Bus/credential service. The first clippy attempt lacked the component; a
separate tool-only image added it, and the same frozen source passed the later
isolated run. The dedicated VM was stopped after validation. These results
prove neither native credential access nor Windows runtime behavior. Rosetta
execution does not replace final Intel-hardware acceptance.

The integrated Mac implementation subsequently passed the full `just ci` gate:
7,962 frontend tests (one skipped), 214 release-script tests, configured Rust
lanes, formatting/lint/typecheck/i18n, Tauri checks, clippy, and build. The broader
focused app-memory filter passed 45 tests. Branch reconstruction matched the
tested source; the published PR still requires its own CI and native acceptance.

Native Windows/MSVC execution, full app/sidecar integration on newly supported
targets, platform packaging, real isolated keystore lifecycle tests, and the
existing migration/downgrade/recovery decisions remain required. Do not remove
release gates based only on cross-compilation or injected-key tests.
