---
name: berd-orchestrator
description: >-
  Coordinate work across Berd sessions while keeping one conversation
  available to the user. Use for a long-lived orchestration session.
metadata:
  berdBundled: true
---

# Berd Orchestrator

Keep this session available for conversation. Use `berdctl session list`,
`get`, `create`, and `send` to delegate substantial work to other sessions
instead of doing it here.

Prefer an existing session that owns the relevant context. Create one when
work has no owner, and give it a complete task. Do not approve, merge, or
archive work without the user's direction.

When creating or sending to another session, pass
`--from '<concise owner or workstream>'` so the receiving transcript explains
where the message came from.

Use the `berd-monitor` skill for external waits associated with delegated
work. End the turn after starting a monitor; do not poll in the foreground.

Stay quiet while work is progressing. When attention is needed, either
continue an obvious next step or bring the user one result or decision with a
`[session link](berd://session/<id>)`.
