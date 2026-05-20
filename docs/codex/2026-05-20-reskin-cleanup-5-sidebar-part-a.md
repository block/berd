# Codex Handoff — Reskin Cleanup PR #5 Part A: Sidebar Fully-Collapse

**Status (2026-05-20 ~02:00 PT):** 🟢 **READY TO START.** Dependencies (#124 tokens, #125 helpers, #126 overlay primitives) land tonight. If you pick this up, claim it in the team Slack thread and update [`docs/handoffs/2026-05-20-reskin-cleanup-pickup.md`](../handoffs/2026-05-20-reskin-cleanup-pickup.md). If nobody picks it up, Tulsi resumes in the morning.

**Date:** 2026-05-20
**Repo:** `squareup/goose-internal` (aka bloose)
**Worktree:** `/Users/tulsi/Documents/New project 2/bloose`
**Branch:** `tulsi/reskin-cleanup-5-sidebar` (create off `origin/main`)
**Owner:** Tulsi (review + push). Commits with hooks are fine; **do not push**.

## Pointers

- **Spec:** `docs/superpowers/specs/2026-05-20-reskin-regression-cleanup-design.md` — PR #5 section, Part A / Part B split
- **Plan:** `docs/superpowers/plans/2026-05-20-reskin-regression-cleanup.md` — Task 5 (Part A is Steps 1–5, plus session-item menu wiring in Step 10)
- **Repo conventions:** `AGENTS.md` at repo root + `src/shared/ui/AGENTS.md`
- **Parent Linear:** [BOT-469](https://linear.app/squareup/issue/BOT-469/track-regressions-from-ui-reskin-merge-stack)

## Dependencies

**PR #1 (tokens), PR #2 (AppShell helpers), and PR #3 (overlay primitives) must all be merged into `origin/main` before starting.** Confirm with:

```bash
git fetch origin
git log origin/main --oneline | head -12
# Expect to see merges for PR #1, PR #2, PR #3
```

If any of those three is unmerged, stop and wait.

## What you're building

The **structural** half of PR #5. Two sub-deliverables:

1. **Fully-collapse regression fix.** When the sidebar is closed, hide it entirely — match branch2's behavior. Main currently keeps a compact icon rail visible; branch2 collapses to nothing (only chrome dots / traffic lights remain). This is universal across every page.

2. **Session-item context menu wiring.** Wire the Rename / Mark unread / Archive context menu onto session items in the sidebar. The popover primitive surface was restored in PR #3; this is just the trigger and item ordering. `SidebarItemMenu.tsx` already exists.

**Out of this slice (Claude subagent owns Part B):** sidebar mask-fade gradient, pinned-section empty visual shell, restored item list/styling (New chat, Home, Agents, …), project section visual grouping, outline-flat pill treatment.

## Files in scope (Part A only)

- **Modify** `src/features/sidebar/ui/Sidebar.tsx` (340 LOC) — collapse early-return; do not touch styling
- **Modify** `src/app/ui/AppShellLayout.tsx` — let canvas span full width when collapsed
- **Modify** `src/app/hooks/useResizableSidebar.ts` — confirm/extend `isCollapsed` + `toggleCollapse` if PR #2 didn't already
- **Modify** `src/features/sidebar/ui/SidebarItemMenu.tsx` — context menu items + ordering
- **Modify** `src/features/sidebar/ui/SidebarChatRow.tsx` — wire the trigger (right-click + "..." button) only if not already wired
- **NEW or extend** `src/features/sidebar/ui/__tests__/Sidebar.test.tsx` — early-return contract

Do **not** touch the styling, mask-fade, pinned section, or project grouping in this stage — those are Part B.

## Starter commands

```bash
git fetch origin
git switch -c tulsi/reskin-cleanup-5-sidebar origin/main

# Audit current collapse behavior
grep -n "isCollapsed\|collapsed\|collapse\|rail\|compact" \
  src/app/hooks/useResizableSidebar.ts \
  src/features/sidebar/ui/Sidebar.tsx \
  src/app/ui/AppShellLayout.tsx

# Get branch2's sidebar shape
git diff origin/main..origin/tulsi/ui-reskin-branch2 -- \
  src/features/sidebar/ src/app/hooks/useResizableSidebar.ts \
  > /tmp/sidebar-diff.patch

# Branch2 commits with the collapse + menu intent
git show d06a85b -- src/features/sidebar/ui/Sidebar.tsx src/app/hooks/useResizableSidebar.ts
git show 5d2203e -- src/features/sidebar/        # mask-fade — for context (Part B owns)
```

## Plan task reference

See `docs/superpowers/plans/2026-05-20-reskin-regression-cleanup.md` Task 5, Part A (Steps 1–5) for the full step list. Part B's mask-fade, pinned shell, and item styling steps (6–9) are *not* your scope. Step 10 (session-item menu wiring) is shared — you wire the trigger and items; Part B handles surface polish if any.

## `useResizableSidebar` contract

This hook is the seam between PR #2 (which set it up) and PR #5 (which uses it). The contract Part A relies on:

```ts
interface ResizableSidebarState {
  width: number;            // current rendered width when not collapsed
  isCollapsed: boolean;     // true → Sidebar.tsx early-returns null
  toggleCollapse: () => void;
  // (plus the existing resize handlers — drag, snap-to-default, etc.)
}
```

If PR #2 already extended this, great — just consume it. If PR #2 didn't (read the hook + check the test backfilled in PR #2 Step 4), extend it here. The plan's PR #2 Step 4 already includes the test that pins this contract.

## Session-item context menu wiring

The menu items (in order): **Rename**, **Mark unread**, **Archive**.

- Use the restored `ContextMenu` primitive from `src/shared/ui/context-menu.tsx` (PR #3 made this opaque + bordered).
- Trigger: right-click on a session row, plus a "..." icon button on hover. Both open the same menu.
- All `<button>` get `type="button"`.
- The actions themselves (rename, mark-unread, archive) likely already exist as mutations or store actions — call them. Do not implement business logic here. If a mutation doesn't exist, flag in the status report and leave that menu item disabled rather than implementing it.

Surface polish (any padding/border/typography drift from branch2) is Part B's call; you wire the behavior.

## Critical for Part B downstream

Part B (Claude subagent) consumes:
- The `isCollapsed` early-return — Part B must not regress this when adding mask-fade or pinned-section shell
- The session-item menu trigger — Part B may restyle the trigger button but must not change its behavior

Flag any structural seam Part B will need (e.g., a prop on `Sidebar.tsx` to opt into a "pinned-section-empty" visual state) in your status report.

## Hard constraints

### Process
- **Branch from `origin/main` after PR #1, PR #2, PR #3 are merged.**
- **Commits are fine** (pre-commit hooks must pass). **Do not push.**
- **No `--no-verify`** on any commit.
- **Two commits in this PR:** Part A from you, Part B from a Claude subagent. Keep Part A self-contained — green build + tests at HEAD-after-your-commit, sidebar fully-collapses, menu opens with three items, no styling regressions.

### Architecture
- **No new Tauri commands.**
- **The pinning section stays empty in this entire PR.** Do not import the layout API. Do not import `useHomeLayoutQuery`. Pinned section is shell-only and that's Part B's empty-visual job.
- **No localStorage for sidebar width persistence** beyond what `useResizableSidebar` already does.

### Style
- `@/` imports.
- `cn()` from `@/shared/lib/cn`.
- All `<button>` need `type="button"` unless intentionally submitting.
- Tokens-only — no hex/rgba.
- **No drop shadows.**

## Verification gates

| What you touched | Command |
|---|---|
| TS, React, frontend | `./bin/just check` |
| Vitest-covered behavior | `./bin/just test` |

Vitest manual-invoke flags: `--bail 1 --reporter=verbose --testTimeout=15000`.

**`AppShell.navigation.test.tsx` is red on branch2** due to upstream churn. On main it must stay green. If a hunk you port from branch2 breaks it on main, fix the test within scope (the failure is likely a missing mock for the helpers — not a real behavior regression).

Visual smoke (in `/private/tmp/bloose-main-run` — confirm the dev app is already running there before relaunching):

- On **every page** (Home, Chat, Skills, Agents, Sessions, Automations, Search, Settings): hit the sidebar collapse control → sidebar disappears entirely, only the chrome dots / traffic-light area remain → re-open → width restores to previous value
- **Session row right-click** → context menu opens (opaque per PR #3) with Rename / Mark unread / Archive in that order
- **Session row "..." button** on hover → same menu
- Existing sidebar items still render and click through correctly (Part B will polish them but the wiring must be preserved)

## Latitude

- **Where the early-return lives** — `if (isCollapsed) return null;` at the top of `Sidebar.tsx` is the simplest path. If you find the layout cleaner with the conditional in `AppShellLayout.tsx` instead (sidebar slot omitted entirely), that's a fair call. Flag the choice.
- **Menu item action wiring** — if a Rename or Archive mutation doesn't exist on main today, the cleanest call is to leave the menu item disabled with a comment pointing to the missing action. Do not implement business logic in this PR.
- **Width-restore behavior** — when re-opening from collapsed, restore to the user's last non-collapsed width (preferred), or to the default width if that's simpler. Match branch2; default is the safer fallback.

## Reporting

When done, include:

1. **Diff stat.** `git diff --stat origin/main..HEAD`
2. **Collapse mechanism** — where the early-return lives, how the layout reclaims space.
3. **Hook contract** — confirm `isCollapsed` / `toggleCollapse` are exposed; note any extension you made.
4. **Menu wiring** — which actions are live, which are disabled-with-comment (if any).
5. **Test coverage** — what you added/updated.
6. **Part B readiness checklist:** confirm the collapse contract is stable, the menu structure is in place (Part B may restyle without changing behavior), and no styling beyond what existed has been changed.
7. **Deviations** from the plan, with reasoning.

When approved, Tulsi handles push; Part B then begins as the second commit on this branch.
