# Reskin Cleanup — Pickup Guide

**Last updated:** 2026-05-20 ~02:00 PT by Tulsi
**Train owner:** Tulsi (will resume morning of 2026-05-20)
**Open to pickup:** yes — see [Pickup workflow](#pickup-workflow) below

If you wake up before Tulsi and want to take a slice of this, follow the workflow. If nobody picks anything up, Tulsi cleans up in the morning — no urgency.

## TL;DR

Nine-PR train cleaning up the visual regressions Morgan's UI-reskin merge stack left on `origin/main`. Each PR is surface-focused, individually reviewable, and bisectable. **Three landed tonight; six remain.**

- **Linear parent:** [BOT-469](https://linear.app/squareup/issue/BOT-469/track-regressions-from-ui-reskin-merge-stack)
- **Spec (the WHAT and WHY):** `docs/superpowers/specs/2026-05-20-reskin-regression-cleanup-design.md`
- **Plan (the HOW, task-by-task):** `docs/superpowers/plans/2026-05-20-reskin-regression-cleanup.md`
- **Open PRs landing tonight:** [#124](https://github.com/squareup/goose-internal/pull/124), [#125](https://github.com/squareup/goose-internal/pull/125), [#126](https://github.com/squareup/goose-internal/pull/126)

## Train state

Assume PRs #124 / #125 / #126 are merged by morning (Tulsi has self-merge rights and they're green on checks). Statuses below reflect post-merge state.

| # | Surface | Owner type | Status | Dependencies | Handoff doc |
|---|---|---|---|---|---|
| 1 | Tokens (globals.css) | Claude subagent | ✅ done (#124) | none | — |
| 2 | AppShell helpers (`useResizableSidebar` seam) | Codex | ✅ done (#125) | none | — |
| 3 | Overlay primitive unification | Claude subagent | ✅ done (#126) | #1 | — |
| 4 | Chrome + PageHeader migration (TopBar action slot, breadcrumb, per-page header removal) | Codex (Stage A) + Claude subagent (Stage B) | 🟢 **ready to start** | #1, #2 | [`docs/codex/2026-05-20-reskin-cleanup-4-chrome-stage-a.md`](../codex/2026-05-20-reskin-cleanup-4-chrome-stage-a.md) |
| 5 | Sidebar fully-collapse + restoration | Codex (Part A) + Claude subagent (Part B) | 🟢 **ready to start** | #1, #2, #3 | [`docs/codex/2026-05-20-reskin-cleanup-5-sidebar-part-a.md`](../codex/2026-05-20-reskin-cleanup-5-sidebar-part-a.md) |
| 6 | Composer pill enrichment | Claude subagent (Codex if structural Home issue) | 🟢 **ready to start** | #1, #3 | plan Task 6 |
| 7 | Chat surface card + glass | Claude subagent | 🟢 **ready to start** | #1 | plan Task 7 |
| 8 | Agent gallery card-fill | Claude subagent | 🟡 blocked on #4 | #1, #4 | plan Task 8 |
| 9 | Skills grid card-fill + flat tile | Claude subagent | 🟡 blocked on #4 | #1, #4 | plan Task 9 |

**Recommended pickup order if you want to maximize unblocking:** #4 first (unblocks #8 and #9). Then #5 / #6 / #7 in any order — they're all independent given #1 / #2 / #3 are landed.

## Tulsi-in-loop checkpoints

These design calls have already required Tulsi's judgment on this train. Either flag them in your PR or hold for her morning review:

1. **PR #5 sidebar fully-collapse:** when collapsed, sidebar disappears entirely (matches branch2). Confirm against branch2 commit `d06a85b`.
2. **PR #6 Home redundant-composer:** Step 1 of Task 6 is "investigate whether the redundant composer on Home is still present after Kalvin's #120 backend hydration." Likely already resolved — confirm before scoping the structural fix.
3. **PR #7 chat-card + glass:** the same "opaque vs glass" trade-off we hit on PR #3's Sheet. The plan says glass for chat. If branch2's surface ratio (`bg-surface-overlay/40 backdrop-blur-md`) looks washed in WKWebView, flag for review rather than over-correcting to opaque.
4. **PR #8 / #9 hover treatments:** branch2 uses card-fill + hover blur. No drop shadows — elevation via surface contrast + (optional) backdrop blur on hover.

## Pickup workflow

If you're picking up a task:

1. **Claim it.** Drop a one-liner in the team Slack thread (or DM Tulsi) so two people don't double-up. Update this doc's "Status" column for your PR to `🔵 claimed by @you`.
2. **Read the handoff doc** for Codex-owned tasks (#4 Stage A, #5 Part A) or **the plan task** for Claude-subagent-owned tasks (everything else). The plan has concrete steps; handoffs have additional Codex-specific framing.
3. **Branch off `origin/main`** (now that #1 / #2 / #3 are merged). Hand-port from branch2 by commit SHA per the plan's porting cheatsheet (`docs/superpowers/plans/2026-05-20-reskin-regression-cleanup.md` ~line 80).
4. **Validate** with `./bin/just check`, `./bin/just test`, and (for `src-tauri/` touches) `./bin/just tauri-check` + `./bin/just clippy`. Vitest manual-invoke flags: `--bail 1 --reporter=verbose --testTimeout=15000`.
5. **Visual gate.** A dev app is set up at `/private/tmp/bloose-main-run` with a unique tauri identifier override (don't revert `src-tauri/tauri.dev.conf.json` there). HMR works — open the surface you touched and eyeball against the spec's screenshot references. `just check` and `just test` do not exercise CSS.
6. **Open a PR** following the spec's behavior-check template — preserved behaviors, intentionally changed behaviors, load-bearing main work touched, surfaces touched, deviations. PR #126 is a good template.
7. **Update this doc** when your PR opens: change status to `🟣 PR #NNN open`.

## Hard constraints (apply to every PR in the train)

These are baked into the spec + plan but worth restating because they trip people up:

- **Branch from `origin/main`. Never from `tulsi/ui-reskin-branch2`.** Reference branch2 by SHA for intent only — hand-port hunks, do not cherry-pick onto an unrelated base.
- **No `--no-verify`** on commits. Pre-commit hooks (lefthook) are load-bearing. `LEFTHOOK=0` was used once for unrelated test debt — do not normalize it.
- **No drop shadows.** Elevation via `bg-surface-overlay`, borders (where appropriate per plan), or contrast. PR #3 established that overlay primitives are borderless; preserve that.
- **Tokens only — no hex/rgba in TS.** JS-side color refs use `var(--token-name)` strings.
- **Tailwind v4 dynamic class names** are invisible to the scanner — use a static lookup map (`const CHIP_BG = { chat: "bg-chip-chat-bg", ... }`), not template literals.
- **All `<button>` need `type="button"`** unless intentionally submitting.
- **Run `pnpm design-system:generate`** after editing shared UI files; otherwise `design-system:audit` blocks the pre-commit hook.

## Known follow-ups (out of scope for this train)

Don't fold these into reskin-cleanup PRs:

- Editor modal final visual styling per Alex's Figma (pending designs)
- Settings redesign (General, Providers, Extensions, Archive, Updates, Doctor)
- Chat context panel design + implementation
- Homepage pinning v2 — needs reconciliation with Kalvin's #120 backend API changes; **not** a clean cherry-pick of branch2 anymore
- Two dead-token refs surviving PR #3: `src/shared/ui/command.tsx:22` and `src/features/design-system/inspector/DesignSystemInspector.tsx:187` (`bg-background-popover`, `text-text-on-popover`, `shadow-popover`)
- Test debt on `tulsi/ui-reskin-branch2`: `MessageBubble.test.tsx`, `SessionHistoryView.test.tsx`, `PersonaEditor.test.tsx`, `AppShell.navigation.test.tsx` are red on branch2 from upstream churn (irrelevant to this train since every PR branches off main)

## If you get stuck

Drop in the Slack thread and Tulsi will resolve in the morning. The work is genuinely optional pickup — don't ship something half-baked because of perceived urgency. Better to leave it for Tulsi than to compound a design-call mistake overnight.
