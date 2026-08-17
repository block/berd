# Berd Demo launcher

Use the demo launcher when you need a manually populated development instance
that cannot share Berd or Goose state with normal development:

```bash
just dev-demo
```

It launches **Berd Demo** as `xyz.block.berd.demo`, so Tauri-managed app data
(including chats, projects, layout, WebView storage, logs, and managed tools) is
separate from both `xyz.block.berd` and `xyz.block.berd.dev`. Goose config,
sessions, agents, plugins, and secrets are rooted under a separate demo
directory, and Goose keyring access is disabled. Builderbot state is isolated
there too. The launcher does not enable experiments or the E2E app driver and
does not seed fixtures; populate the app manually.

The demo state persists between launches at:

- macOS: `~/Library/Application Support/Berd Demo`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/berd-demo`

Set `BERD_DEMO_ROOT` to an absolute path before launching to use another
persistent location. Removing that directory and the platform app-data
locations for `xyz.block.berd.demo` resets the demo; normal Berd and Goose data
must not be removed.
