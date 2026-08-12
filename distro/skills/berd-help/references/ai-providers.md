# AI Providers

A provider connects a session's chosen model to Berd. After credentials are
saved, Berd fetches the provider's live model list as a side effect — that
request doubles as connection verification (it validates the key, URL, and
network in one shot). Raw provider errors are mapped to a stable set of
actionable causes worth knowing directly, since this mapping is a
deliberate, documented behavior rather than an implementation detail likely
to move:

- **401/403 or "unauthorized"/"invalid API key"** → the credential itself
  was rejected. Have the user re-check the key.
- **404 / "not found"** → the server was reachable but the path was wrong.
  Most often a missing `/v1` suffix on a custom provider URL.
- **Connection refused, timeout, DNS failure, "network error"** → nothing
  answered at all. Check the URL, network, and whether the provider's
  service is up.
- **429 / "rate limit" / "too many requests"** → the key works; the
  provider is throttling. Not a configuration problem.

For provider setup that runs through a CLI installer (some providers install
a local binary), a different, narrower failure taxonomy applies — an
existing file at the target path, or an unsupported OS/architecture
combination — see `src/features/providers/lib/agentSetupTroubleshooting.ts`.
Do not guess at which specific providers are available, curated, or
custom-only from memory; verify against `src/features/providers/`
(`curatedProviders.ts`, `providerCatalog.ts`) since the provider list and
setup flow are active areas of change.

If the question is actually about an automation failing rather than a chat
session, see `references/automations.md` for how to tell which phase failed
before assuming a provider cause.
