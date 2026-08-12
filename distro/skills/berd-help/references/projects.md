# Projects

A project groups chats around a working directory: it can hold one or more
project workspaces (folders, repos, or worktrees), has its own artifact
rendering, and can carry a startup mode governing how new chats in it start
from those workspaces. A project's active state (in the Projects nav view)
is distinct from an **archived** project (a Settings surface — see
`references/settings.md`); don't conflate the two when a user asks where a
project went. Source lives in `src/features/projects/`; verify current
workspace/startup-mode behavior there, since this has direct interaction
with git worktrees and can change.
