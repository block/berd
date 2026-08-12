# Docker BB Acceptance Harness

This harness builds the current `bb` binary in Docker and runs it as an unprivileged user. Every run creates a new container-local `HOME`, `BB_HOME`, skills state directory, agent skills directory, and file-backed auth location. It never mounts a developer home or places a credential in an image layer.

## Offline mock

From the Berd repository root:

```bash
just bb-cli-docker-acceptance
```

The default mode starts a deterministic local marketplace fixture inside the container. It installs the skills-only `default` bundle, repeats the install, runs an update, validates BB metadata and bundle provenance, and confirms an unmanaged skill file survives. Agent-bundle installation is intentionally outside this contract.

## Live KGoose or Playpen

Pass the URL and credential only when starting the container:

```bash
docker run --rm \
  -e BB_ACCEPTANCE_MODE=live \
  -e BB_MARKETPLACE_BASE_URL=https://kgoose.stage.sqprod.co \
  -e BB_SESSION_CREDENTIAL="$BB_SESSION_CREDENTIAL" \
  -e KGOOSE_PLAYPEN=my-playpen \
  bb-cli-acceptance
```

`KGOOSE_PLAYPEN` is optional. The runner forwards it to `bb`; it does not construct HTTP headers, so Playpen routing continues to use the CLI's authoritative Baggage behavior. The runtime credential is written to a container-local file-backed auth store and removed with the temporary home when the container exits. Do not pass a home-volume mount or put credentials in the Dockerfile.

`BB_ACCEPTANCE_BUNDLE` is available only for targeted diagnostics against a non-release fixture. Release validation must leave it unset so the harness exercises the canonical `default` bundle.
