# App test driver development

A build with the `app-test-driver` feature preserves the legacy local-driver
behavior by default: it uses the regular Berd/Goose profile and Keychain,
listens on `APP_TEST_DRIVER_PORT` (default `9999`), and accepts the existing
loopback protocol. `just dev` and `just dev-e2e` both use this mode.

Strict state isolation is a separate, explicit opt-in. It requires both:

1. a Rust binary built with `app-test-driver`; and
2. `BERD_E2E_MODE=1` with a validated per-run identifier, root, run ID, and
   driver token.

Use the shared Unix/macOS launcher through the explicit recipe argument:

```bash
just dev-e2e isolated=1
```

It creates a temporary run root, builds the instrumented source app, and writes
`client.env` plus `app-test-driver.json` under that root. Source `client.env` in
a second shell before running `pnpm test:app-e2e` or `pnpm test-driver`.

For an autonomous OpenAI-backed run, the trusted outer controller supplies a
short-lived token and selects the checked-in, non-secret runtime catalog:

```bash
export E2E_PROVIDER_TOKEN='short-lived restricted token'
export BERD_E2E_PROVIDER_ID=openai
export BERD_E2E_MODEL_ID=gpt-4o-mini
export BERD_E2E_PROVIDER_KEY_ENV=E2E_PROVIDER_TOKEN
export BERD_E2E_RUNTIME_CONFIG="$PWD/scripts/e2e-runtime-config.openai.json"
just dev-e2e isolated=1
```

The producer writes the credential only to
`<run-root>/goose/config/secrets.yaml`, while keyring access is disabled. It
never copies a regular Berd/Goose profile. The outer controller remains
responsible for minting/revoking the short-lived credential, terminating the
process tree, collecting screenshots, and deleting the run root and per-run app
identity directories on every exit path.

Windows uses the same runtime contract through `scripts/windows/Dev-Windows.ps1`.
Set `BERD_E2E_MODE=1`, `BERD_E2E_RUN_ROOT`, and the optional provider bootstrap
environment above before invoking it; the app owns its random driver port and
publishes readiness under the run root.
