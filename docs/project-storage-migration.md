# Project storage migration

Projects and their session associations are moving from Goose-owned Markdown and session metadata to Berd's existing `berd.sqlite` database. The migration is deliberately monotonic and does not activate the new authority in this change.

## Ownership boundary

| Data | Legacy authority | Native authority |
| --- | --- | --- |
| Project records, order, archive state, and workspaces | Goose project Markdown | Berd SQLite |
| Session-to-project association | Goose session `_meta.projectId` | Berd `session_projects` |
| Conversation and session lifecycle | Goose | Goose |
| Project prompt composition | Goose | Berd immediately before dispatch |

The last three ownership changes must activate together. Switching only project CRUD would leave Goose reading retained Markdown while Berd writes SQLite, and switching only prompt composition would duplicate or omit model instructions.

## Persisted phases

- `legacy`: Goose remains the only authority.
- `shadow`: Berd mirrors the fixed Goose project directory, but all product reads and writes still use Goose.
- `native`: Berd owns project reads, writes, associations, and prompt lookup. The database trigger prevents a transition back to `legacy` or `shadow`.

This change exposes no native-activation command. It starts a retryable shadow import when project listing first runs and leaves the existing Goose request path unchanged.

## Shadow import contract

The importer resolves the same process/login-shell `GOOSE_PATH_ROOT` precedence used to launch `goose serve`, then scans only `<goose-data>/projects`.

- Inputs are deterministically ordered and limited to 1,000 regular, non-symlink Markdown files of at most 1 MiB each.
- Exact source bytes are SHA-256 fingerprinted and copied to a content-addressed Berd recovery directory before the SQLite transaction.
- The recovery directory is anchored below Berd app data, rejects symlink components, and has a 1 GiB aggregate safety limit. Reaching the limit fails the passive scan without changing Goose-owned product behavior.
- Project rows, workspaces, receipts, migration status, and the phase change commit in one transaction.
- Re-running is idempotent. Changes continue to refresh the mirror while Goose is authoritative.
- Goose mutations force a reconciliation; read-triggered reconciliations are limited to once per 30 seconds to avoid repeatedly hashing the full collection.
- A database-backed scan generation rejects stale results and stale failures across windows or concurrent Berd processes. Unchanged rescans do not manufacture collection revisions.
- A missing or changed source root cannot erase an existing mirror.
- Unknown frontmatter properties are preserved as JSON for compatibility.
- Original Goose files are never changed or deleted.
- A Berd build refuses to read or rewrite a migration run created by a newer schema version.

Database corruption now writes a durable recovery marker, preserves the database/WAL/SHM files, and blocks subsequent startup. Berd no longer silently creates an empty authoritative database after corruption.

## Session loading in the native end state

Goose will continue to load session conversations. Berd overlays the association using `(session_backend_id, session_id)`, where the backend namespace is stable across provider or harness changes. A stored nullable row is an explicit "no project" tombstone and wins over legacy metadata; absence of a row permits one-time legacy backfill.

The project must be resolved from SQLite immediately before every foreground or queued dispatch. Persistence failure must retain the queued message and prevent the user turn from being committed. Renderer local storage remains a presentation cache only.

## Native activation blockers

Native activation is not safe until all of these are resolved in one pinned Berd/Goose release:

1. Goose commit `063694cf769269c1f151416605687991fdcbc496`, currently pinned in `goose-backend.lock.json`, is not reachable from the configured upstream. That exact source must be recovered and verified before its two project-prompt injection paths can be removed or capability-gated.
2. Session create and fork need a durable operation correlation so a crash between Goose session allocation and Berd association persistence can reconcile on restart.
3. Every session list/info/import/fork/provider-recovery path must overlay Berd associations, including archived projects and paginated results.
4. Project changes must be resolved at dispatch time; queued sends must fail closed on database errors, and project moves during an active turn need a defined next-turn policy.
5. Cross-window mutations need revision-aware broadcasts/refetch, and product callers must await association persistence before updating UI state.
6. Downgrade after native writes is not lossless because retained Markdown becomes stale. A rollback build must retain the Berd reader or run a tested reverse export; otherwise downgrade must be explicitly unsupported.
7. External ACP providers have no generally revocable system-prompt channel. Clearing or moving a project cannot remove project context already sent in-band, which requires a documented product decision.
8. Activation must prove the latest claimed scan completed successfully against the current source root and that no newer scan is in flight. A bounded-backup maintenance and user-visible failure policy is also needed before the passive 1 GiB limit can become an authoritative migration dependency.
9. Filesystem checks prevent direct symlink inputs and redirected backup roots, but portable Rust path APIs cannot make the whole directory walk atomic against a privileged process swapping parent directories. Native activation needs an anchored directory-handle implementation or an explicit threat-model decision.
10. Native project deletion must tombstone affected session associations and increment their revisions in the same transaction before deleting the project. The schema deliberately restricts implicit foreign-key deletion so this cannot be skipped.
11. Compatibility needs shared golden fixtures that run the same legacy sources through Goose, renderer normalization, and Berd import. The Rust compatibility cases cover known workspace and filename variants but do not prove the cross-language contract.
12. Worst-case shadow scan and SQLite lock time needs measurement at the 1,000-file/1 GiB input bound. Durable failure status exists in SQLite, but user-visible reporting or telemetry is still required before activation.

Until these gates pass, `shadow` is the only safe deployed state.
