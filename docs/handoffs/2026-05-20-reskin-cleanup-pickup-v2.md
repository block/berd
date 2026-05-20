# Reskin Cleanup — Pickup Guide (v2, post-#4)

**Last updated:** 2026-05-20 mid-day by Tulsi (with Claude)
**Supersedes:** [`2026-05-20-reskin-cleanup-pickup.md`](2026-05-20-reskin-cleanup-pickup.md) — that doc was the night-of snapshot; this one reflects the post-#4 train state.
**Open to pickup:** yes — see [Pickup workflow](#pickup-workflow)

## TL;DR

Five PRs left in the nine-PR cleanup train. **#4 just landed**, which means #8 and #9 are unblocked. **Codex's next slot is PR #5 Part A** (sidebar fully-collapse + collapse-state plumbing) — the handoff doc for it is already on main.

- **Linear parent:** [BOT-469](https://linear.app/squareup/issue/BOT-469/track-regressions-from-ui-reskin-merge-stack)
- **Spec (the WHAT and WHY):** `docs/superpowers/specs/2026-05-20-reskin-regression-cleanup-design.md`
- **Plan (the HOW, task-by-task):** `docs/superpowers/plans/2026-05-20-reskin-regression-cleanup.md`

## Train state

| # | Surface | Owner type | Status | Dependencies | Handoff doc |
|---|---|---|---|---|---|
| 1 | Tokens (globals.css) | Claude | ✅ merged (#124) | none | — |
| 2 | AppShell helpers (`useResizableSidebar` seam) | Codex | ✅ merged (#125) | none | — |
| 3 | Overlay primitive unification | Claude | ✅ merged (#126) | #1 | — |
| 4 | Chrome + PageHeader migration + dot-grid root | Claude | ✅ merged (#128) | #1, #2 | — |
| 5 | Sidebar fully-collapse + restoration | **Codex (Part A)** + Claude (Part B) | 🟢 **ready** | #1, #2, #3 | [`docs/codex/2026-05-20-reskin-cleanup-5-sidebar-part-a.md`](../codex/2026-05-20-reskin-cleanup-5-sidebar-part-a.md) |
| 6 | Composer pill enrichment | Claude (Codex if structural Home issue surfaces) | 🟢 ready | #1, #3 | plan Task 6 |
| 7 | Chat surface card + glass | Claude | 🟢 ready | #1 | plan Task 7 |
| 8 | Agent gallery card-fill | Claude | 🟢 ready (unblocked by #4) | #1, #4 | plan Task 8 |
| 9 | Skills grid card-fill + flat tile | Claude | 🟢 ready (unblocked by #4) | #1, #4 | plan Task 9 |

**Suggested pickup order:** #5 first (it's the next Codex slot and the structural piece in the remaining set). Then #7 / #8 / #9 / #6 in any order — all four are independent given #4 is on main.

## When does Codex come in?

**Now — PR #5 Part A.** The structural / collapse-state half of the sidebar work was carved out for Codex because it touches:

- `useResizableSidebar` (extending the `isCollapsed` seam PR #125 added),
- `Sidebar.tsx` early-return,
- `AppShellLayout.tsx` width reclaim,
- a real Vitest for the collapse contract.

Part B (mask-fade, pinned-section shell, item styling, session-item context menu wiring) is a Claude subagent task that lands as a second commit on the same branch. The split + the existing Codex handoff doc are designed so Codex can pick this up cold from the doc without re-reading the whole train.

If Codex isn't around when someone wants to start #5, Claude can do Part A from the same handoff doc — the plan calls out either path.

## Tulsi-in-loop checkpoints

Calls that have required (or are likely to require) Tulsi's eyes on the remaining train:

1. **#5 sidebar fully-collapse** — confirm collapsed = sidebar gone entirely (matches branch2 `d06a85b`). Tulsi already verified this intent against branch2.
2. **#6 Home redundant-composer** — Step 1 of Task 6 is an investigation: is the redundant composer on Home still present after Kalvin's #120 backend hydration? Likely already resolved; confirm before scoping any structural fix.
3. **#7 chat-card + glass** — same "opaque vs glass" trade-off PR #3's Sheet hit. Plan says glass for chat. If branch2's surface ratio (`bg-surface-overlay/40 backdrop-blur-md`) reads washed in WKWebView, flag for review rather than over-correcting to opaque.
4. **#8 / #9 hover treatments** — branch2 uses card-fill + hover blur. **No drop shadows.** Elevation comes from surface contrast and (optional) backdrop blur on hover.

## Things PR #4 changed that downstream PRs should expect

The hand-port from branch2 deviated in a few places. Worth knowing so you don't re-port the branch2 form on top:

1. **Hook signature is the branch2 split**, not the plan's wrapper.
   - `useTopBarActions(): ReactNode | null` — getter, used by `TopBar.tsx`.
   - `useSetTopBarActions(): (node: ReactNode | null) => void` — setter, used by pages from `useEffect` with cleanup.
   - Provider lives at `src/app/App.tsx` wrapping `<AppShell>`, not inside AppShell.
   - Source: `src/app/contexts/TopBarActionsContext.tsx`.
2. **TopBar height is 56px** (token: `--spacing-app-top-bar`). PR #5 anchors its layout against this — don't reset.
3. **TopBar `chromeInsets` prop preserved.** Branch2 dropped it; main keeps it so macOS fullscreen still falls back to a tight leading inset instead of a 96px traffic-light gap.
4. **AppShell root paints `bg-dot-grid`**, not `bg-background`. Chrome surfaces (sidebar, etc.) are translucent over the grid. If you add a new top-level surface in PR #5, expect to read frosted over dots and pick its bg accordingly.
5. **SessionHistory uses the giant 56px inline search input** (no PageHeader, no separate SearchBar). PR #6's composer work shouldn't reintroduce a separate search component on this surface.
6. **`AutomationsView.test.tsx` requires a `TopBarActionsProvider`** wrapper + outlet to query the action buttons. Any new test that mounts a page using `useSetTopBarActions` needs the same wrapper.
7. **Dead-token cleanup deferred to a follow-up:** `src/shared/ui/command.tsx:22` and `src/features/design-system/inspector/DesignSystemInspector.tsx:187` still reference `bg-background-popover`, `text-text-on-popover`, `shadow-popover`. Out of scope for this train.

## Pickup workflow

1. **Claim it.** Drop a one-liner in the Slack thread or DM Tulsi so two people don't double-up. Update the row in the table above to `🔵 claimed by @you`.
2. **Read the handoff doc** for Codex-owned tasks (#5 Part A) or **the plan task** for Claude-subagent-owned work.
3. **Branch off `origin/main`** — every dependency in the table is now on main, so no stacked-branch mode needed for any remaining PR.
4. **Validate** with `./bin/just check`, `./bin/just test`, and (for `src-tauri/` touches) `./bin/just tauri-check` + `./bin/just clippy`. Manual Vitest invocations: `--bail 1 --reporter=verbose --testTimeout=15000`.
5. **Visual gate.** Dev app at `/private/tmp/bloose-main-run` with its own Tauri identifier (`com.squareup.goose-internal.dev.main-worktree`) — isolated data dir means it won't hit the migration-mismatch panic the main workspace gets when switching between branches with different migration sets. To check out a branch there: `git stash push -m "tauri.dev override" src-tauri/tauri.dev.conf.json`, switch, restore the override file. HMR works.
6. **Open a PR** using PR #128 as the template (preserved / intentionally-changed / load-bearing-touched / surfaces / deviations).
7. **Update this doc** when your PR opens.

## Hard constraints

Restated for visibility:

- **Branch from `origin/main`.** Reference branch2 by commit SHA for intent only — hand-port hunks, do not cherry-pick onto an unrelated base.
- **No `--no-verify`** on commits. Pre-commit hooks (lefthook) are load-bearing.
- **No drop shadows.** Elevation via `bg-surface-overlay`, borders (where appropriate per plan), or contrast.
- **Tokens only — no hex/rgba in TS.** JS-side color refs use `var(--token-name)` strings.
- **Tailwind v4 dynamic class names** are invisible to the scanner — static lookup map, not template literals.
- **All `<button>` need `type="button"`** unless intentionally submitting.
- **Run `pnpm design-system:generate`** after editing shared UI primitive files.
- **Do not push without Tulsi's explicit approval.** Commits with hooks are fine; `git push` waits for review.

## Known follow-ups (out of scope for this train)

- Editor modal final visual styling per Alex's Figma (pending designs)
- Settings redesign (General, Providers, Extensions, Archive, Updates, Doctor)
- Chat context panel design + implementation
- Homepage pinning v2 — needs reconciliation with Kalvin's #120 backend API changes; **not** a clean cherry-pick of branch2
- Two dead-token refs surviving PR #3 (see #7 in "Things PR #4 changed" above)
- Test debt on `tulsi/ui-reskin-branch2`: `MessageBubble.test.tsx`, `SessionHistoryView.test.tsx`, `PersonaEditor.test.tsx`, `AppShell.navigation.test.tsx` are red on branch2 from upstream churn — irrelevant since every PR here branches off main

## If you get stuck

Drop in the Slack thread and Tulsi will resolve. The work is genuinely optional pickup — better to leave a slice for Tulsi than to compound a design-call mistake.
