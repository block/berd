# Connections & Extensions

Connections and Extensions are two different underlying concepts that share
one settings surface (Settings → Connections):

- A **connection** is an OAuth sign-in to an external app or service the
  agent can act through (e.g. Slack, GitHub, Google Drive) — from a catalog
  Berd defines (`src/features/connections/catalog.ts`).
- An **extension** is a directly-configured tool integration (stdio, SSE,
  streamable HTTP, ACP, or builtin) — a user or admin supplies the command,
  URL, or config directly rather than signing in.

Both render side by side in the same grid because from the user's point of
view they're both "things Berd can use on your behalf," but they have
different edit/delete rules. Some connections are **company-managed**
(provisioned centrally, matched against the same catalog) and should not be
treated as freely editable or deletable the way a user's own custom
extension is — check `isCompanyManagedExtension` behavior in
`src/features/connections/lib/managedExtensions.ts` before telling a user
how to change or remove one. A connection can also be **expiring** or
**expired**, distinct from simply disconnected (`connectionStatus.ts`) — if
a user reports a connection "not working," ask whether it shows expired
before assuming it's a setup problem.
