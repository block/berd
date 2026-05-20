# Codex Handoff — Reskin Cleanup PR #4 Stage A: Chrome Infrastructure

**Status (2026-05-20 ~02:00 PT):** 🟢 **READY TO START.** Dependencies (#124 tokens, #125 helpers) land tonight. If you pick this up, claim it in the team Slack thread and update [`docs/handoffs/2026-05-20-reskin-cleanup-pickup.md`](../handoffs/2026-05-20-reskin-cleanup-pickup.md). If nobody picks it up, Tulsi resumes in the morning.

**Date:** 2026-05-20
**Repo:** `squareup/goose-internal` (aka bloose)
**Worktree:** `/Users/tulsi/Documents/New project 2/bloose`
**Branch:** `tulsi/reskin-cleanup-4-chrome-pageheader` (create off `origin/main`)
**Owner:** Tulsi (review + push). Commits with hooks are fine; **do not push**.

## Pointers

- **Spec:** `docs/superpowers/specs/2026-05-20-reskin-regression-cleanup-design.md` — read PR #4 section, especially Stage A / Stage B split
- **Plan:** `docs/superpowers/plans/2026-05-20-reskin-regression-cleanup.md` — Task 4 (Stage A is steps 1–7)
- **Repo conventions:** `AGENTS.md` at repo root + `src/shared/ui/AGENTS.md`
- **Parent Linear:** [BOT-469](https://linear.app/squareup/issue/BOT-469/track-regressions-from-ui-reskin-merge-stack)

## Dependencies

**Both PR #1 (tokens) and PR #2 (AppShell helpers) must be merged into `origin/main` before starting this PR.** Confirm with:

```bash
git fetch origin
git log origin/main --oneline | head -10
# Should show PR #1 and PR #2 merge commits
```

If either is unmerged, stop and wait.

## What you're building

The **chrome infrastructure** half of PR #4. Two sub-deliverables:

1. **`TopBarActions` context + portal** — a small new mechanism so any page can mount its action buttons into the TopBar action slot. New file at `src/app/ui/TopBarActions.tsx`, with a `<TopBarActionsProvider>`, a `<TopBarActionSlot>` outlet, and a `useTopBarActions(node)` hook for pages to consume.
2. **TopBar reshape** — `src/app/ui/TopBar.tsx`: 56px height, macOS traffic-light inset (~80px), breadcrumb `Tulsi's World / <Section>`, the action slot outlet at the right edge.

This Stage A ends with a green build + a TopBar that visually shows the breadcrumb and renders an empty action slot. **Stage B** (per-page PageHeader removal + action-slot consumption on Agents/Skills/Automations/Sessions) is owned by Claude subagents and lands as a second commit inside this same PR.

## Files in scope (Stage A only)

- **NEW** `src/app/ui/TopBarActions.tsx` — context + provider + outlet + hook
- **NEW** `src/app/ui/TopBarActions.test.tsx` — mount/unmount contract test
- **Modify** `src/app/ui/TopBar.tsx` (currently 199 LOC) — height, traffic-light inset, breadcrumb, slot outlet
- **Modify** `src/app/ui/AppShellLayout.tsx` (63 LOC) — wrap with provider at the right tree level
- **Modify** `src/app/AppShell.tsx` — provider placement
- **Possibly modify** `src/app/ui/AppShellContent.tsx` — only if route → section name mapping lives here

Do **not** touch `src/features/*/ui/*View.tsx` in this stage — those are Stage B.

## Starter commands

```bash
git fetch origin
git switch -c tulsi/reskin-cleanup-4-chrome-pageheader origin/main

# Get branch2's TopBar shape
git diff origin/main..origin/tulsi/ui-reskin-branch2 -- \
  src/app/ui/TopBar.tsx src/app/ui/AppShellLayout.tsx src/app/AppShell.tsx \
  > /tmp/topbar-diff.patch
wc -l /tmp/topbar-diff.patch

# Branch2 commits with the action-slot mechanism
git show a5ee6fd -- src/app/ui/TopBar.tsx src/app/ui/AppShellLayout.tsx
git show d06a85b -- src/app/ui/TopBar.tsx        # height + traffic-light inset
git show d524f71 -- src/app/ui/TopBar.tsx        # lighter page-label tone
git show 14e5a1d -- src/app/ui/                  # chrome-panel top-edge alignment
```

## `TopBarActions` contract (the seam for Stage B)

Stage B will call `useTopBarActions(<actions>)` from `AgentsView.tsx`, `SkillsView.tsx`, `AutomationsView.tsx`, `SessionHistoryView.tsx`. The hook must:

- Mount the passed node into the slot on render
- Clear the slot on unmount
- Replace cleanly when the node identity changes (page navigation)

The plan (Task 4, Step 3) gives a reference implementation using React Context + `useState` + `useEffect`. That implementation is correct and intentionally minimal. If you prefer a portal-based approach (`React.createPortal` into a `ref`'d DOM node in TopBar) for fewer re-renders, that's a fair call — flag in your status report.

What you **must not** change without flagging:
- The hook signature `useTopBarActions(node: ReactNode): void` — Stage B writes against this
- The presence of a single global slot (not per-route, not stacked) — Stage B assumes one slot per app

## Plan task reference

See `docs/superpowers/plans/2026-05-20-reskin-regression-cleanup.md` Task 4, Stage A (Steps 1–7) for the full step list, including the `TopBarActions` reference implementation (Step 3) and the contract test (Step 4).

## Critical for downstream PRs

- **PR #5 (sidebar)** uses TopBar height as a layout anchor. If you change height from 56px, flag it.
- **Stage B** of this same PR (the Claude subagent half) hard-depends on the `useTopBarActions` signature above.
- **PR #4 risk #1 in the spec:** total PR target is 200–400 LOC. Your Stage A commit should be ≤200 LOC of the total. If your stage alone exceeds ~250 LOC, flag for split consideration.

## Hard constraints

### Process
- **Branch from `origin/main` after PR #1 + PR #2 are merged.** Confirm with `git log origin/main --oneline | head`.
- **Commits are fine** (pre-commit hooks must pass). **Do not push.**
- **No `--no-verify`** on any commit.
- **Two commits in this PR:** Stage A from you, Stage B from a Claude subagent. Keep your Stage A commit self-contained (build + tests green at HEAD-after-your-commit, with the action slot rendering empty).

### Architecture
- **No new Tauri commands.**
- **The action slot is React-only.** Do not introduce a Zustand store or any global state library just for this.
- **Section name for the breadcrumb** — derive from the active route. If a route → section helper already exists, use it. If not, a small switch over the route is fine. Don't introduce a route registry just for this.

### Style
- `@/` imports.
- `cn()` from `@/shared/lib/cn`.
- All `<button>` need `type="button"` unless intentionally submitting.
- Tokens-only — no hex/rgba.
- **No drop shadows** on TopBar. Elevation via border / contrast / surface tokens (`bg-surface-chrome` etc., introduced in PR #1).
- TopBar height: 56px. Traffic-light inset on macOS: ~80px (verify against branch2's exact value; `process.platform === 'darwin'` or equivalent Tauri check).

## Verification gates

| What you touched | Command |
|---|---|
| TS, React, frontend | `./bin/just check` |
| Vitest-covered behavior | `./bin/just test` |
| If you somehow touch `src-tauri/` (you shouldn't) | also `./bin/just tauri-check` |

Vitest manual-invoke flags non-negotiable: `--bail 1 --reporter=verbose --testTimeout=15000`.

Visual smoke:
- Dev app TopBar shows breadcrumb `Tulsi's World / <Section>` on each page
- Action slot area at the right edge is empty (Stage B will fill it)
- Traffic-light area on macOS doesn't overlap any content
- No drop shadow under TopBar
- All existing TopBar buttons (if any) still work

## Latitude

- **Portal vs Context for the slot mechanism** — Context with a single `useState` is the plan's recommendation; portal is a fine alternative if you prefer. Either way, keep the consumer hook signature stable.
- **Breadcrumb tone / size** — `d524f71` lightens the page-label tone. Apply that polish; you don't need to chase pixel parity with branch2 since downstream visual PRs will catch any drift.
- **AppShellContent split** — if AppShellContent.tsx has business logic that should arguably live in AppShell.tsx (or vice versa), feel free to move it as part of this refactor *if* the move is small. If it's a bigger refactor, defer and flag.

## Reporting

When done, include:

1. **Diff stat.** `git diff --stat origin/main..HEAD`
2. **`TopBarActions` design choice** — context vs portal, where the provider lives in the tree.
3. **Breadcrumb derivation** — how you get the section name from the route.
4. **macOS traffic-light handling** — the exact mechanism used.
5. **Deviations** from the plan, with reasoning.
6. **Stage B readiness checklist:** confirm the hook signature `useTopBarActions(node: ReactNode): void` is in place, the slot outlet is in TopBar, and a dev-app smoke test confirms the slot accepts and clears nodes correctly. Stage B owners will write against this.

When approved, Tulsi handles push; Stage B then begins as the second commit on this branch.
