# Auto model routing

A distribution can expose named Auto modes in the model picker with
`goose.autoRouting` in its runtime config. Each mode uses Goose and declares an
actual Goose `modelProviderId`, candidate models, and a concrete fallback. No
router runs until the user selects an Auto mode and sends a message.

The router chooses a candidate for each queued turn before the prompt starts.
Berd applies the chosen provider/model and a supported reasoning effort through
ACP. If routing fails, times out, or returns an invalid candidate, Berd uses the
mode's fallback. Explicit model selection leaves Auto mode.

`modelId` is the provider's served endpoint ID. `routerModel` is the name understood
by the router; they can differ. `harness` defaults to `codex` and describes the
router candidate's benchmark harness, not a change to Berd's Goose backend.
Responses may omit the `system.ai.` prefix; numeric versions such as `6.1` and
`6-1` are equivalent when matching router names. The response must identify one
configured model and its configured harness.

Efforts are ordered `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
`minEffort` and `maxEffort` bound each candidate. An omitted effort defaults to
`medium`, clamped into those bounds. A returned effort is also clamped. A mode's
fallback must reference a candidate and specify an effort within its bounds.
Only effort choices actually supported by the session are applied.

The default timeout is 5 seconds; `timeoutMs` accepts 1–120000 milliseconds.
`defaultModeId` optionally selects an initial mode. Omit it to retain the
distribution's ordinary initial model. All mode IDs and router model/harness
pairs must be unique within their containing lists. A provider can discover
candidate model IDs dynamically; candidate IDs need not appear in its optional
runtime model metadata.

## Refreshing config for new chats

Before resolving a new chat's Auto mode and initial model, Berd refreshes runtime
config through `refresh_runtime_config_for_new_chat`. UI and CLI creation paths
share this boundary, including reuse of an empty draft. Opening an existing
conversation does not refresh config. The first prompt waits for creation to
finish, so it cannot dispatch using defaults captured before the refresh.

The native resolver reads the distribution's existing config source and bounds
that read to five seconds. Failed, invalid, or timed-out reads retain the last
valid source config. Without a valid source result, config remains unavailable;
a transient failure is never evidence that a saved Auto mode was removed.
Concurrent new-chat requests share a refresh, and older responses cannot replace
newer config. An explicit model or persona selection remains authoritative.
Routing uses one effective config snapshot per attempt. If routing settings
change during preparation, the prompt stays uncommitted for retry; a refresh
with unchanged routing settings does not interrupt it.

`autoRouting` remains in `runtime-config.json`. No LaunchDarkly flag is enabled
by this change. A future distribution integration can evaluate a JSON flag for
selected sections, merge it over the bundled config, validate the effective
config, and return it through this same native resolution boundary. The picker
and native router must receive the same effective config; updating only the
renderer store is not sufficient. Flag identity, keys, and targeting belong to
the distribution. Refresh evaluates the current source value for each new chat;
a retained streaming flag client need not make a new network request each time.

## Gateway example

The following configuration illustrates a deployment-owned Databricks gateway.
Replace the example host, path, provider model IDs, and selector with values
supported by your gateway. This is a protocol example; gateways do not all expose
this routing endpoint.

```json
{
  "schemaVersion": 1,
  "goose": {
    "defaultModelProviderId": "databricks_v2",
    "defaultModelId": "team-gpt-6-1-sol",
    "modelProviders": [{
      "id": "databricks_v2",
      "displayName": "Databricks",
      "models": [{"id": "team-gpt-6-1-sol", "name": "GPT Sol"}]
    }],
    "autoRouting": {
      "url": "https://example.cloud.databricks.com/ai-gateway/routing/v1/routes:select",
      "timeoutMs": 5000,
      "bearerTokenEnv": "DATABRICKS_TOKEN",
      "routeSelector": {
        "router_name": "task_v3",
        "config": {"model": "system.ai.gpt-6-luna"}
      },
      "modes": [{
        "id": "auto-balanced",
        "displayName": "Auto (balanced)",
        "modelProviderId": "databricks_v2",
        "fallback": {"modelId": "team-gpt-6-1-sol", "effort": "high"},
        "models": [{
          "modelId": "team-gpt-6-1-sol",
          "routerModel": "system.ai.gpt-6-1-sol",
          "minEffort": "high",
          "maxEffort": "max"
        }, {
          "modelId": "team-claude-opus",
          "routerModel": "system.ai.claude-opus",
          "maxEffort": "high"
        }]
      }, {
        "id": "auto-premium",
        "displayName": "Auto (premium)",
        "modelProviderId": "databricks_v2",
        "fallback": {"modelId": "team-claude-opus", "effort": "high"},
        "models": [{
          "modelId": "team-claude-opus",
          "routerModel": "system.ai.claude-opus",
          "minEffort": "medium",
          "maxEffort": "high"
        }]
      }]
    }
  }
}
```

Set `DATABRICKS_TOKEN` in the environment of the Berd desktop process when the
router requires a bearer token, using your existing credential tooling. A macOS
app launched from Finder does not automatically inherit a shell's environment.
`bearerTokenEnv` names the environment variable; never put a token into runtime
config. This routing credential is independent of Goose's inference-provider
sign-in. Berd does not extract Goose OAuth tokens. Omit `bearerTokenEnv` for a
gateway that authenticates through its own network boundary. Omit
`routeSelector` when the gateway selects the router itself. Runtime config
rejects URL credentials/query parameters and secret-looking selector keys;
arbitrary authentication headers are not supported.

## Router protocol and diagnostics

Each fresh prompt includes task text, loaded skill instructions, and recent
conversation context, with up to 24,000 characters for each source. Metadata
and text previews for up to four explicitly attached local files contribute
up to 24,000 characters per file. The complete routing context is capped at
176,000 characters, leaving room for all seven sections and their metadata. Images
and directories contribute metadata; remote paths are not read locally. Steering
an in-progress turn keeps its current model and does not call the router.

The native backend posts this JSON to the configured URL, avoiding browser CORS:

```json
{
  "route_options": [{"model": "system.ai.gpt-6-1-sol", "harness": "codex", "min_effort": "high", "max_effort": "max"}],
  "task": {"prompt": "Bounded context for the turn"},
  "route_selector": {"router_name": "task_v3", "config": {"model": "system.ai.gpt-6-luna"}}
}
```

The response identifies exactly one route:

```json
{
  "route_selection": [{
    "route_option": {"model": "gpt-6-1-sol", "harness": "codex"},
    "params": {"task_tier": "High", "reasoning_effort": "high"}
  }],
  "rationale": "Selected a candidate for this task."
}
```

`params.reasoning_effort`, `params.effort`, or selection-level `effort` can carry
the optional effort. Unknown efforts or candidates fall back. Responses are
limited to 1 MiB and redirects are disabled. Requests cannot override the
configured URL, selector, candidate allowlist, or credentials.

The complete accepted response remains in the current session's in-memory Auto
details. Rationale and evidence can quote task context, so the response is never
written to the app log, persisted into session history, or sent as telemetry.
Transport logs record response byte counts and request duration on success.
On failure they record only the diagnostic code, HTTP status when applicable,
elapsed milliseconds, and configured timeout. Request prompts, endpoint URLs,
authentication headers, and error-response bodies are never logged by the
routing transport. Feedback
exports exclude entire older app log files that contain raw router-response
records, including multiline bodies and files whose exported tail starts inside
a response.

Expand **Why this model?** to inspect the last routing decision. Native transport
failures set `fallbackReason` to a stable code and include a `failure` object:

```json
{
  "code": "http_error",
  "elapsedMs": 245,
  "timeoutMs": 5000,
  "httpStatus": 429
}
```

Codes distinguish `timeout` (including a timeout while reading the body),
`connection_failed`, `http_error`, `invalid_json`, `response_too_large`,
`response_read_failed`, `client_unavailable`, `credential_unavailable`, and
other `request_failed` errors. Connection failures can include DNS or TLS
failures; the raw error chain is not retained. Old native errors or unrecognized
command failures remain generic `request_failed` decisions without a `failure`
object. The timeout budget and fallback model selection are unchanged.

These details describe that attempt, not the router's current health. A new
prompt makes a new routing attempt.
