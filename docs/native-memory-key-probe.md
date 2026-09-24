# Native memory keychain probe

## Historical local result (2026-09-18)

**Cross-executable interoperability was not established.** A local diagnostic
successfully created and read a synthetic key in its parent process. A separately
named reader exceeded its 8-second deadline and was terminated. The parent then
deleted the exact synthetic entry and verified `keyring::Error::NoEntry`.

No keychain prompt was approved or automated. A blocked authorization prompt is
a possible explanation, but the timeout alone does not establish its cause.
No native denial code was observed.

The diagnostic used a unique synthetic service/account, not production
credentials or a real memory store. It did not output the key. Cleanup was
verified; the run-specific identifier is omitted from this document.

## Scope and reproducibility

This is a report of a local experiment, not a checked-in test or a reproducible
checkout procedure. The diagnostic source is not included in this change.

The experiment used debug executables on macOS, `keyring 3.6.3` with the
`apple-native` backend, and `security-framework 3.7.0`. It does not validate signed
release identities, entitlements, keychain authorization, upgrades, Windows, or
Linux. It also does not establish memory-store encryption or recovery behavior.

## Required acceptance work

Before release, test the actual signed app and bundled sidecar together in an
isolated OS account or VM using synthetic content. Verify initialization,
approved recall, relaunch, upgrades, denied prompts, and unavailable credentials.
Never automate credential-prompt approval or access production entries for this
test. Use a unique test namespace and verify exact-entry cleanup.

See [macOS acceptance](memory-macos-acceptance.md) for the isolated signed-build
procedure and read-only signature-inspection helper. That helper verifies
metadata, not Keychain authorization. Windows, Linux, and Intel Mac memory
support is deferred; their first-release checks establish feature absence.
Do not describe this historical timeout as successful native interoperability.
