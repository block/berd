# Sessions

A session is a single conversation with an agent — what a user casually
calls a "chat." It's the object `berdctl session` and `sessions.json`'s
strings name it as; "chat" is the informal word for the same thing, not a
separate object. A session runs on a harness — `goose`, `claude-acp`,
`codex-acp`, `copilot-acp`, `amp-acp`, or `cursor-agent` — chosen per
session; a question about a specific harness's own behavior is out of scope
for this skill (see the Scope section in `SKILL.md`). Within a session, a
user can attach workspaces (folders/repos), tag in skills and agents, and
open artifacts (rendered files) in a side viewer. A session can also be
forked, renamed, moved into a project, or archived.

This is the largest and fastest-changing surface in the app — do not
describe specific composer behavior, artifact viewer capabilities, or
transcript UI from memory. Verify against `src/features/chat/` (particularly
`hooks/useChat*.ts` for session behavior and `ui/ArtifactViewer.tsx` for the
artifact viewer), `src/shared/i18n/locales/en/sessions.json` for session
history/archive/fork/import behavior, or the live UI before answering
anything specific.

## The right rail (files, worktrees, terminal)

A session's right rail is scoped to whatever workspace(s) (folders, repos,
worktrees) are attached to that session — the same attachment concept named
above, not a separate feature. It composes a few distinct pieces: a
workspace list, a changes view (git status/diff for the attached workspace),
an artifacts view (files opened from the session), and a dockable terminal
that can open at a specific path. "Where did my files go" or "what's the
changes tab" questions are almost always about one of these, scoped to the
session's attached workspace(s) — ask which workspace/project the user means
if it's ambiguous. This is one of the most actively-changing parts of the
app; verify specifics against `src/features/chat/ui/ContextPanel.tsx` and
`src/features/terminal/` rather than describing widget behavior from memory.
