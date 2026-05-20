# Codex Handoff — Reskin Cleanup PR #2: AppShell Helpers

**Status (2026-05-20 ~02:00 PT):** ✅ **DONE.** Shipped as [PR #125](https://github.com/squareup/goose-internal/pull/125). This handoff is kept for archival reference.

**Date:** 2026-05-20
**Repo:** `squareup/goose-internal` (aka bloose)
**Worktree:** `/Users/tulsi/Documents/New project 2/bloose`
**Branch:** `tulsi/reskin-cleanup-2-appshell-helpers` (create off `origin/main`)
**Owner:** Tulsi (review + push). Commits with hooks are fine; **do not push**.

## Pointers

- **Spec (the WHAT and WHY):** `docs/superpowers/specs/2026-05-20-reskin-regression-cleanup-design.md` — read PR #2 section
- **Plan (the HOW):** `docs/superpowers/plans/2026-05-20-reskin-regression-cleanup.md` — Task 2
- **Repo conventions:** `AGENTS.md` at repo root + `src/shared/ui/AGENTS.md`
- **Parent Linear:** [BOT-469](https://linear.app/squareup/issue/BOT-469/track-regressions-from-ui-reskin-merge-stack)

Read the spec section + plan task end-to-end before starting.

## What you're building

A pure refactor of `src/app/AppShell.tsx` and its layout siblings to re-integrate three helpers that branch2 expects downstream PRs to consume:

- `useResizableSidebar` — sidebar width + collapse state hook (`src/app/hooks/useResizableSidebar.ts`)
- `useProjectDialog` — project create/edit dialog state hook (`src/app/hooks/useProjectDialog.ts`)
- `settingsSectionUrl` — settings deep-link URL builder helper

The hooks exist on main but main may still inline some of the behavior they encapsulate. Branch2 has cleaner consumption. The goal is to make AppShell match branch2's shape so PR #4 (TopBar) and PR #5 (sidebar) can build on a stable structural base.

**No visual change.** The dev app behaves identically before/after.

## Files in scope

- `src/app/AppShell.tsx` — primary consumer
- `src/app/ui/AppShellLayout.tsx` (63 LOC) — layout container
- `src/app/ui/AppShellContent.tsx` — content router/router-outlet area
- `src/app/hooks/useResizableSidebar.ts` — extend to expose `isCollapsed` if missing (PR #5 will rely on this)
- `src/app/hooks/useProjectDialog.ts` — verify wired
- `src/app/hooks/useResizableSidebar.test.ts` — NEW if missing (test the collapse contract for PR #5)

## Starter commands

```bash
git fetch origin
git switch -c tulsi/reskin-cleanup-2-appshell-helpers origin/main

# Audit current consumption
grep -n "useResizableSidebar\|useProjectDialog\|settingsSectionUrl" \
  src/app/AppShell.tsx src/app/ui/*.tsx

# Get branch2's shape
git diff origin/main..origin/tulsi/ui-reskin-branch2 -- \
  src/app/AppShell.tsx src/app/ui/ src/app/hooks/ > /tmp/appshell-diff.patch
wc -l /tmp/appshell-diff.patch

# Branch2 commits to inspect for intent
git show 036b18a -- src/app/  # "parity batch"
git show 9a25494 -- src/app/  # already on main; confirm what landed
```

## Plan task reference

See `docs/superpowers/plans/2026-05-20-reskin-regression-cleanup.md` Task 2 for the full step list. Summary:

1. Audit current state — find inline duplications
2. Diff branch2 to identify which inlinings to replace
3. Port helper consumption one at a time; run `just check && just test` after each
4. Backfill `useResizableSidebar.test.ts` if missing (concrete test code in the plan, Step 4)
5. Validation: `just check && just test`
6. Visual no-change check in dev app
7. Commit (single commit OK for a pure refactor)
8. Status report

## Critical for PR #5 downstream

PR #5 depends on `useResizableSidebar` exposing an `isCollapsed` boolean and a `toggleCollapse()` action. If main's current hook doesn't expose those, **extend the hook in this PR** (do not defer to PR #5 — it would force PR #5 to grow beyond its scope). The plan's Step 4 includes the contract test that pins this down.

## Hard constraints

### Process
- **Branch from `origin/main`.** Not from any other branch. Confirm with `git log --oneline -5` after branching.
- **Commits are fine** (pre-commit hooks must pass). **Do not push.**
- **No `--no-verify`** on any commit.

### Architecture
- **No new Tauri commands.**
- **No new business-logic localStorage.**
- **No new files outside the listed scope** (the test file is the only allowed new file).

### Style
- `@/` imports.
- `cn()` from `@/shared/lib/cn`.
- All `<button>` need `type="button"` unless intentionally submitting.
- Tokens-only — no hex/rgba. (Likely irrelevant for this PR — it's a refactor — but the rule stands.)
- No drop shadows.

## Verification gates

| What you touched | Command |
|---|---|
| TS, React, frontend | `./bin/just check` |
| Vitest-covered behavior | `./bin/just test` (or `pnpm vitest run <path> --bail 1 --reporter=verbose --testTimeout=15000`) |

**Vitest manual-invoke flags non-negotiable** (`--bail 1 --reporter=verbose --testTimeout=15000`) — a hung test silently consumed ~30 min of subagent budget on 2026-05-18.

Visual smoke (this is a refactor — behavior unchanged):
- Sidebar resize drag still works
- Project create dialog still opens
- Settings deep-links still resolve

## Latitude

If you see a cleaner refactor path than what branch2 used, take it and flag in the status report. Tulsi reads deviations carefully. The constraint is: behavior identical, downstream PRs (especially PR #4 and PR #5) have the seams they need.

If `useResizableSidebar` already exposes `isCollapsed` on main, skip the hook extension and just confirm the test in Step 4. If it doesn't, extend it — the contract is small (boolean + toggle).

## Reporting

When done, include:

1. **Diff stat.** `git diff --stat origin/main..HEAD`
2. **What was removed.** Which inline duplications on main got replaced with helper calls.
3. **Hook extension.** Whether `useResizableSidebar` needed a new `isCollapsed` seam, and what its contract is now.
4. **Tests.** What you added/updated.
5. **Deviations.** Any departures from the plan, with reasoning.

When approved, Tulsi handles the push and merge.
