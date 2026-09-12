# Backend process recovery

Berd stores one compact, owner-private recovery record per backend under the app data directory's `processes/berd-serve` folder. Legacy shared-temp JSON records are never read or migrated. Upgrading can leave an older backend for manual cleanup or a reboot.

Publication retains the file it created through startup and shutdown. A terminal newline commits a single-line payload; readers reject incomplete writes. Windows publishes and deletes through retained file handles and revalidates the record and directory ACLs before deletion. Unix creates the final name exclusively and never unlinks by pathname: there is no portable atomic operation that deletes only the retained file when another process can replace its name. Partial and completed records therefore remain as recovery evidence on Unix, including after a clean shutdown.

Stale recovery requires an exact owner identity and an orphaned backend identity. Linux probes through a retained `/proc` directory descriptor and signals that same process with `pidfd_send_signal`; unsupported kernels retain evidence without falling back to a numeric PID signal. Windows checks and terminates through one process handle. macOS cannot yet establish the required executable identity, so it retains evidence without signaling stale records. Normal shutdown still terminates and reaps the owned child on all platforms.

A failed startup retains any unreaped child in memory. Another startup must finish that teardown before it can spawn a replacement; the app exit path also retries it. A child already reaped by readiness checks counts as confirmed exited.

Recovery streams directory entries off the async runtime through a buffer of at most 256 paths. Enumeration and process cleanup have a two-second startup budget. Scans continue beyond the first buffer while time remains. Exhausting the budget leaves unprocessed evidence for a later attempt; recovery does not guarantee a full scan of an arbitrarily large directory. Retained Unix records can consume disk space over time.

## Validation

`just tauri-test` and the Windows-native `just ci-windows` gate include these focused suites:

- `services::acp::process_record_store`: publication substitution, partial writes, ACL changes, exact deletion, directory parsing, and scan buffering.
- `services::acp::goose_serve::recovery_tests`: failed startup, already-reaped children, retry ownership, signal escalation, and retained evidence.
- `services::process::`: process identity and the Linux exit-between-probe-and-signal regression.

Run the native Linux and Windows CI jobs before merging; compilation on macOS cannot validate those operating-system operations.
