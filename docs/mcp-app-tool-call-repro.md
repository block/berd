# MCP app tool-call contract reproduction

This fix supplies `extensionName` when an MCP app calls a server tool. It matches
Goose's pinned request schema and preserves the existing `extension__tool` name.
It does **not** enable app frames or change frame policy or security transport.
Full native rendering validation remains blocked pending separate security and
frame-policy work; see [#53](https://github.com/block/berd/pull/53).

## Public clock app

Use the official [Basic Server (Vanilla JS)](https://github.com/modelcontextprotocol/ext-apps/tree/92f46a574568a3ddac7600343b7d3c4c4ed7b588/examples/basic-server-vanillajs)
from ext-apps v1.7.5, matching the ext-apps version used by Berd's
`@mcp-ui/client` 7.1.1. It needs no API key and returns the real server clock.
Its **Get Server Time** button calls `get-time` with `{}` arguments and displays
`structuredContent.time`. Its resource is `ui://get-time/mcp-app.html` with MIME
`text/html;profile=mcp-app`.

In a separate scratch directory, with Git, npm and Node 22 or 24:

```sh
git clone https://github.com/modelcontextprotocol/ext-apps.git ext-apps-public-demo
cd ext-apps-public-demo
git checkout --detach 92f46a574568a3ddac7600343b7d3c4c4ed7b588
npm ci
npm run build --workspace @modelcontextprotocol/server-basic-vanillajs
node examples/basic-server-vanillajs/dist/index.js --stdio
```

`npm ci` runs upstream's prepare/build script. Keep the source lockfile; the build
uses its Bun dependency. The last command starts a stdio server, not a web page.
Stop that process before letting Berd start its own instance. Preserve upstream's
license and attribution: package manifests say MIT, while the repository LICENSE
explains mixed historical MIT/Apache-2.0 code and CC-BY-4.0 documentation.

## Future native acceptance steps (not yet observed)

After the separate security and frame-policy prerequisites are approved:

1. Use a disposable Berd profile. In **Settings → Connections → Add connection**,
   ask the setup agent to add a local Goose stdio MCP named `public-clock`.
2. Supply the absolute Node executable path as the command. Supply the absolute
   path to `examples/basic-server-vanillajs/dist/index.js`, then `--stdio`, as
   two arguments. No environment secrets are needed. Review and approve the
   proposed configuration; do not edit a live profile for this test.
3. Enable the connection for a fresh Goose session. The pinned backend requires
   auto mode for app-initiated tool calls; use only this harmless clock extension.
4. Ask the agent to invoke `get-time`. Confirm the native inline app displays
   a concrete initial timestamp, not Loading or Error.
5. After the clock advances, click **Get Server Time**. Confirm a new timestamp
   arrives from the awaited server call. Leave unrelated app controls unused.
6. Capture actual native before/after screenshots without unrelated chats or
   private data. Upload through GitHub's native attachment UI; do not substitute
   a browser mock, upstream image, or committed screenshot for native evidence.

## Evidence for this partial fix

The host regression checks the app callback's outgoing request. The SDK contract
regressions check the serialized extension method payload, required validator
field, and the request definition from the pinned public Goose schema. These
checks do not exercise a WebView or prove native rendering.

The source-pinned demo checkout was obtained, but `npm ci` failed with archive
integrity errors in the test environment. Its build and MCP stdio round trip
were not observed. No native app was launched, no user profile was changed, and
no native screenshots are available. The commands above are source-verified
reproduction instructions, not a claim that installation or the full app passed.
