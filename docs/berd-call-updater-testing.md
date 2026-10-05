# Bundled Berd Call updater rehearsal

This macOS scenario tests the real packaged updater without starting a voice call or changing the production Berd application. It cold-launches an isolated app through `berd://update-check`, serves a signed archive over local HTTPS, holds the same shared lock as a call, and verifies replacement after releasing that lock.

The test requires pnpm, Python 3, OpenSSL with `req -addext`, and the normal Berd build prerequisites. Port 14443 must be available. The `--trust-localhost` option explicitly authorizes temporarily trusting a generated certificate in the login keychain. macOS may ask for confirmation. Normal completion, failures, and handled interruption remove the certificate and its trust. Do not forcibly kill the test with SIGKILL. No developer signing identity or production updater key is required.

## Build the isolated source

From the checkout, run normal dependency and sidecar preparation (`just setup`), then:

```sh
VITE_UPDATER_ENABLED=true VITE_AUTH_GATE=0 pnpm tauri build --features berdctl,app-test-driver --bundles app --config tests/app-e2e/bundled-updater.tauri.json
```

Use the absolute `Berd.app` path printed by the build. The overlay gives the app a separate E2E identifier and registers the native updater plugin. The test rejects a production app identifier. The fixture's configuration key is not a secret: each test generates its own signing key and replaces the disposable copy's release catalog.

## Run the signed replacement scenario

```sh
node scripts/test-bundled-updater.mjs /absolute/path/from/build/Berd.app --trust-localhost
```

The script creates source and target bundles, signing keys, the signed compatibility descriptor, HTTPS feed, run directory, and driver token. It copies the source under a unique user Applications directory, disables legacy-data migration and keyring access through E2E mode, and leaves the original source and production app unchanged.

Expected output:

```text
SIGNED_ARCHIVE_DOWNLOADED_WITH_INSTALL_BLOCKED
SIGNED_REPLACEMENT_VERIFIED manifests=1 archives=1 evidence=... app=...
TEST_CERTIFICATE_TRUST_REMOVED
```

The target is a synthetic `99.0.0` fixture containing an added proof file, not a new release binary. The test verifies that the signed target payload replaces the disposable app, its bundle signature remains valid, and its bundled CLI matches the target archive. The call-equivalent lock avoids microphone use; it tests the same cross-process installation barrier but does not retest speech or call startup. Evidence and disposable bundles are retained at the printed paths for inspection. The app and its backend are stopped on completion.

If the machine crashes or the process is forcibly killed, remove test trust with `security remove-trusted-cert <evidence>/cert.pem`. Read its fingerprint using `openssl x509 -in <evidence>/cert.pem -noout -fingerprint -sha1`, then remove that exact certificate using `security delete-certificate -Z <fingerprint-without-colons> ~/Library/Keychains/login.keychain-db`. Never delete other certificates.

## Development command installation and restoration

To exercise installation and restoration without replacing an existing developer installation, use disposable command directories. Substitute the built bundle's absolute CLI path in the first two commands:

```sh
install_root=$(mktemp -d)
mkdir "$install_root/bin"
ln -s /absolute/path/from/build/Berd.app/Contents/MacOS/berd-call "$install_root/bin/berd-call"
BERD_CALL_DEV_BINDIR="$install_root/bin" BERD_CALL_DEV_LIBEXECDIR="$install_root/libexec" bash scripts/install-berd-call-dev.sh install /absolute/path/from/build/Berd.app/Contents/MacOS/berd-call
"$install_root/bin/berd-call" --version
BERD_CALL_DEV_BINDIR="$install_root/bin" BERD_CALL_DEV_LIBEXECDIR="$install_root/libexec" bash scripts/install-berd-call-dev.sh uninstall
readlink "$install_root/bin/berd-call"
```

The command prints its version after installation, and the final link points back to the exact original bundle CLI. `just install-berd-call-dev` runs this same installer after building the development binary; `just uninstall-berd-call-dev` runs its uninstall action. An executable fixture scenario in `scripts/install-berd-call-dev.test.mjs` additionally covers reinstallation and refusal to replace unrelated commands.
