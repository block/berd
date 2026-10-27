# Goose schedules in Berd: proposed stack

## Product boundary

Berd should expose the scheduler already owned by the embedded `goosed` process. Local Goose schedules belong in the shared Automations hub, next to company-managed automations when that service is available, but neither product should depend on the other. OSS builds must never issue KGoose/G2 requests just to show local schedules. The app should clearly distinguish local schedules from company-managed automation records.

The current Berd pin already includes typed ACP schedule list, update, pause/resume, delete, run-stop, and per-schedule session-history requests. Initial UI work therefore needs no backend pin or SDK regeneration. The scheduler may be disabled or unavailable on some ACP servers; surface that as a local-scheduler error, isolated from the company-managed section.

## Proposed PR stack

| Layer | Scope | Acceptance |
|---|---|---|
| 1. `feat(automations): show local Goose schedules in OSS` | Give local schedules an OSS capability independent of the KGoose-gated company Automations capability; mount a read-only local schedule list in the shared hub; keep company-only details, history, builder, and requests gated. | With company automations disabled, list local jobs and status, and prove that company list/detail requests are not made. In the Block build, both sources remain visible in the same hub. |
| 2. `feat(automations): configure local Goose schedules` | Add guarded cron editing to the embedded schedule list, with supported-expression validation and save/cancel states. | Invalid input is rejected before reaching ACP, and valid updates use the typed update method against the live scheduler. The current Goose update handler mutates the active job before validating the new cron, so the UI must not pass unsupported expressions. |
| 3. `feat(automations): manage local Goose schedules` | Add pause/resume, stop active runs, confirmed removal, and bounded per-schedule run history on demand. Share the local ACP adapter between UI and `berdctl` if/when CLI controls are restacked. | Mutations use typed ACP on the same live Goose process; enforce running-job restrictions; removal preserves the recipe; history is fetched only when requested and remains bounded. Review deletion behavior against the exact Goose version before adding any multi-step pause/delete/rollback sequence. |
| Future upstream dependency | Add durable project/workspace context to scheduled jobs and pass it into every run's session creation. Then expose project filtering/association in Berd. | Schedule association survives restart and each execution uses the selected project's stable ID and workspace roots. |

Each proposed layer should be reviewed as a working prefix. The current first implementation covers only Layer 1; the later controls and upstream project-scoped execution work are planned separately because they carry distinct behavioral risks.

## Project association

A real association cannot be implemented accurately as UI-only metadata. In the pinned scheduler, job executions create sessions at the Goose process's current working directory. The schedule DTO and create/update requests do not contain a project ID, cwd, or additional workspace roots. Berd projects do have stable IDs, but attaching one only to display metadata would mislead users about where scheduled agents actually run. A later upstream Goose change should persist project/workspace context on each job and apply it when every scheduled session is created; Berd can then select a project and navigate run history into the right project.

## Performance and JEV

No JEV package, capability, or reference exists in this repository or the checked dependency manifests. Do not introduce or assume one without identifying the intended library. Schedule listing is one bounded UI query that shares the existing 15-second refresh cadence; TanStack Query handles cache lifecycle. TanStack Virtual is already installed and used for long session lists, but should only be applied if realistic schedule volumes make rendering measurable. Per-schedule history should load on demand with a small limit rather than polling history for every schedule. If later performance measurements show polling or large result sets are a bottleneck, first consolidate query ownership and seek server pagination/push updates before adding virtualization alone.

## Reference and known issue

PR #245 (`block/berd#245`) demonstrates the same embedded ACP scheduler path, but mixes local schedules into a company Automations workbench that still mounts company-backed polling and builder flows. It also includes CLI schedule commands. Reuse its typed ACP approach, but keep OSS surface gating separate. Review schedule removal against the live backend before adding a client-side pause/delete/rollback transaction; that sequence can race another actor, and rollback failure can hide the original deletion error. Also gate company detail actions synchronously: Query's `enabled: false` does not stop an explicit `refetch()`.
