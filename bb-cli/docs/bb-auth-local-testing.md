# BuilderBot Local Auth Testing

This covers local CLI auth testing for BuilderBot identity.

The important invariant is that the browser must hit `/auth/login` and `/auth/callback`
on the same host that Auth0 redirects to. kgoose uses an HttpOnly state cookie between
those two requests before it redirects back to the CLI with a short-lived exchange code.

While BuilderBot staging is only reachable from a laptop through a Kubernetes
port-forward, keep the backend Auth0 redirect URI as:

```text
http://localhost:5173/cash-app/goose/auth/callback
```

Then point the CLI at the same local host.

For the target login sequence, see [BuilderBot Auth Flow](bb-auth-flow.md).

## Build

From `goose-internal/bb-cli`:

```bash
source ./bin/activate-hermit
cargo build --bin bb
```

## Test Against A Port-Forward

Find the running pod and dynamic Java app port:

```bash
kubectl -n kgoose-builderbot get pods -o wide

kubectl -n kgoose-builderbot exec <pod-name> -c kgoose-builderbot -- \
  sh -c "ss -ltnp | awk '/java/ {print \$4}' | tr '\n' ' '"
```

Forward local `5173` to the dynamic app port, not the declared `8080` health/admin port:

```bash
kubectl -n kgoose-builderbot port-forward pod/<pod-name> 5173:<dynamic-java-port>
```

In another terminal, run the CLI login command through the port-forward:

```bash
./target/debug/bb config set org test

BB_AUTH_STORAGE=file \
BB_AUTH_STORAGE_FILE="$(pwd)/target/bb-auth-sessions.json" \
KGOOSE_BASE_URL="http://localhost:5173" \
  ./target/debug/bb auth login
```

Expected result:

- the browser opens `http://localhost:5173/cash-app/goose/auth/login`
- kgoose redirects to Auth0 with `redirect_uri=http://localhost:5173/cash-app/goose/auth/callback`
- Auth0 redirects the browser back through the same port-forward
- kgoose validates the state cookie, exchanges the Auth0 code server-side, and redirects to the CLI loopback callback with a one-time exchange code
- the CLI exchanges that code through kgoose and stores the returned session credential

By default, the CLI stores browser auth sessions in the OS keyring. For local debugging without touching keyring state, use the `BB_AUTH_STORAGE=file` command above.

## Test In Staging

Point the CLI at the real staging URL:

```bash
./target/debug/bb config set org test

KGOOSE_BASE_URL="https://blockstaging.build" \
  ./target/debug/bb auth login
```

## Test Against A Playpen

Set `BB_KGOOSE_PLAYPEN` when you need to route backend auth requests to a playpen. Replace `<playpen-route>` with your full kgoose playpen route value.
The Chrome extension must be enabled for playpen login so browser requests route through the playpen.

```bash
BB_AUTH_STORAGE=file \
BB_AUTH_STORAGE_FILE="$(pwd)/target/bb-auth-sessions.json" \
BB_KGOOSE_PLAYPEN="jsibbison--cash-usw2" \
KGOOSE_BASE_URL="https://blockstaging.build" \
  ./target/debug/bb auth login
```

## Notes

- For port-forward testing, use `localhost:5173`, not `127.0.0.1:5173`, so the browser host matches the registered Auth0 callback URL.
- The dynamic Java app port is the port that serves `/cash-app/goose`; `8080` is the health/admin listener.
- Non-local-dev `bb` commands require `org`; set it with `bb config set org <org>` or let interactive `bb auth login` prompt for it.
- `KGOOSE_BASE_URL` is the pure base URL. The CLI derives the org-routed host, then appends `/cash-app/goose` when it calls auth and marketplace endpoints.
- `BB_KGOOSE_PLAYPEN` routes bb backend requests with `Baggage: kgoose-builderbot-playpen=<playpen-route>`.
- Do not log callback query strings, cookies, or returned session credentials.
