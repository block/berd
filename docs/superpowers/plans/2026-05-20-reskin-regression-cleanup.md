# Reskin Regression Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `origin/main` to the intended visual design from `tulsi/ui-reskin-branch2`, in nine surface-focused PRs, while preserving every load-bearing piece of architecture (backend layout, design-system inspector, onboarding migration, avatar catalog, bundled skills, app-shell helpers) that landed on main during Morgan's UI takeover.

**Architecture:** Nine independently reviewable, bisectable PRs. Each branches from current `origin/main`, hand-ports relevant hunks from named `tulsi/ui-reskin-branch2` commits, and ships with its own validation gate. Foundation trio (Tokens / AppShell helpers / Overlay primitives) lands first; the remaining six (Chrome+PageHeader, Sidebar, Composer, Chat, Agents, Skills) fan out once their dependencies are merged. Visual work uses a running-dev-app verification gate (Vitest does not exercise CSS). Structural work uses real Vitest/Rust tests.

**Tech Stack:** Tauri 2 + React 19 + TypeScript, Tailwind v4 with `@theme inline` tokens, Radix UI primitives, Vitest, Cargo test, sqlx + SQLite.

**Spec:** `docs/superpowers/specs/2026-05-20-reskin-regression-cleanup-design.md`
**Parent Linear:** [BOT-469](https://linear.app/squareup/issue/BOT-469/track-regressions-from-ui-reskin-merge-stack)

---

## Critical conventions

These apply to every task. Read once; do not re-prove with each step.

- **Stacked-branch operating mode (2026-05-20 onward):** Nothing in this train gets merged into `origin/main` until the whole visual recovery looks right. Each PR branches off the prior PR's branch when its dependency isn't yet on main, not off `origin/main`. PR #3 branches off `tulsi/reskin-cleanup-1-tokens`. PR #4 needs PR #1 + PR #2 — branch off one and layer the other's commit (cherry-pick or merge). Etc. **Never branch from `tulsi/ui-reskin-branch2`**. Reference branch2 by commit SHA for *intent* only — hand-port the relevant hunks; do not cherry-pick onto an unrelated base.
- **No pushes without explicit approval.** Per AGENTS.md and the session's restated rules: commits with pre-commit hooks are fine, but `git push` only after Tulsi has reviewed the local diff and explicitly OK'd the push. At the end of each PR task, report ready-for-review with diff stats; do not push.
- **No `--no-verify`.** Pre-commit hooks (lefthook) are load-bearing. If a hook fails, fix the underlying issue. `LEFTHOOK=0` was used once for unrelated test debt; do not normalize it.
- **No drop shadows anywhere.** Elevation via `bg-surface-overlay`, borders, or contrast. PR #3 in particular: when restoring opaque overlay surfaces, do not reintroduce a `shadow-*` utility. The dialog primitive already follows this (`shadow-popover: none` at globals.css:277, 493).
- **Tokens only — no hex/rgba in TS.** JS-side color refs use `var(--token-name)` strings when passing through `style`.
- **Tailwind v4 dynamic class names are invisible to the scanner.** Template literals like `` `bg-chip-${kind}-bg` `` will not be emitted. Use a static lookup map (`const CHIP_BG = { chat: "bg-chip-chat-bg", project: "bg-chip-project-bg", ... }`).
- **`--color-{name}` bridge naming** in the `@theme inline` block is what makes Tailwind utilities resolve. When adding a token, add both the raw token (`--surface-card-soft: ...`) and its bridge (`--color-surface-card-soft: var(--surface-card-soft)`).
- **All `<button>` elements need `type="button"` unless intentionally submitting.**
- **`@/` imports + `cn()`** from `@/shared/lib/cn`.
- **Run `pnpm design-system:generate`** after any change to shared UI primitive files (PR #3 in particular). The pre-commit hook runs `design-system:audit` and will block otherwise.
- **No new Tauri commands.** None of these PRs add new backend commands. Backend layout API extensions are already in (PR #109 + #120).
- **Validation gate per file class.** Required gates per PR are listed inline:
  - Frontend (CSS, .tsx, .ts in `src/`): `just check` + `just test`
  - Anything in `src-tauri/`, Tauri config, or Rust: also `just tauri-check` + `just clippy`
  - Sweeping/release-style changes: `just ci`
- **Visual verification gate.** `just check` and `just test` do not ground-truth CSS. Before reporting any visual PR done, load the affected surface in the running dev app and eyeball against the screenshots referenced in the spec.
- **Vitest invocation guard.** When invoking Vitest manually (not via `just test`), include `--bail 1 --reporter=verbose --testTimeout=15000`. A hung test silently consumed ~30 min of subagent budget on 2026-05-18.
- **Dev app for current main** lives at `/private/tmp/bloose-main-run` with a unique tauri identifier override in its `tauri.dev.conf.json`. **Do not revert that identifier** — it isolates the data dir from the branch2 dev instance. Before launching, check whether the dev app is already running there.
- **Branch2 test debt is not blocking.** `MessageBubble.test.tsx`, `SessionHistoryView.test.tsx`, `PersonaEditor.test.tsx`, `AppShell.navigation.test.tsx` are red on branch2 from upstream churn. Each PR here branches off main, so this only matters if you hand-port a hunk that breaks one of those tests on main — then fix it under the PR's scope.

## Branch2 commits referenced (porting cheatsheet)

| SHA | Surface | Used by PR |
|---|---|---|
| `72c5e93`, `fc05744`, `5072e2b`, `7b44dc1` | Tokens / globals / chat tokens | #1, #7 |
| `9a25494`, `036b18a` | AppShell helper refactor | #2 |
| `eaceacb`, `613bc0c` | Overlay surface system + page-action restoration | #3, #4 |
| `a5ee6fd` | TopBar action slot + bottom fade + card fill | #4 |
| `d524f71` | Agents empty-state strip + TopBar page-label tone | #4, #8 |
| `14e5a1d` | Editor overlay polish + chrome-panel top-edge alignment | #4 |
| `d06a85b` | Sidebar + TopBar reskin per Figma 891:11342 | #5 |
| `5d2203e` | Sidebar mask-fade + outline-flat pill | #5 |
| `6c99bfe` | Universal search + global composer port (delta only) | #6 |
| `9006642` | Agents list page per Figma 916:17434 + full-width grid | #8 |
| `8f48c53` | Skills list per Figma 1022:3419 — chromeless flat grid | #9 |
| `d843332` | Skill tile hover blur + fill, sibling height match | #9 |

Inspect any of these with: `git show <sha> -- <path>` (e.g. `git show 7b44dc1 -- src/features/chat/ui/ChatView.tsx`).

## Dependency DAG and parallelization

```
        ┌── PR #1 Tokens ────┐
origin ─┤                    ├── PR #3 Overlay primitives ──┬── PR #4 Chrome + PageHeader ──── PR #5 Sidebar
        └── PR #2 AppShell ──┘                              │
                                                            ├── PR #6 Composer pill
                                                            ├── PR #7 Chat surface
                                                            ├── PR #8 Agent cards
                                                            └── PR #9 Skills cards
```

- **PR #1 and PR #2** are parallel-safe — start both simultaneously.
- **PR #3** waits on PR #1 to land.
- **PR #4** waits on PR #1 and PR #2 to land.
- **PRs #5–#9** can begin in parallel as soon as their listed dependencies are merged. (PR #5 needs #1+#2+#3; PR #6 needs #1+#3; PR #7 needs #1; PRs #8/#9 need #1+#4.)
- The merge-train cadence is "one merge into main → kick off any newly unblocked PRs." The plan does not force serialization beyond the DAG.

---

## File structure (per PR)

The plan does not create many new files. The exception is PR #4's optional `TopBarActions` action-slot component and tests. Everything else is edits to existing files.

```
src/shared/styles/
  globals.css                                       # PR #1 (heavy), PR #7 (chat token if missing)

src/app/
  ui/
    TopBar.tsx                                      # PR #4 Stage A
    AppShellLayout.tsx                              # PR #4 Stage A, PR #5
    AppShellContent.tsx                             # PR #2
    TopBarActions.tsx                               # PR #4 Stage A — NEW (action-slot context + portal)
    TopBarActions.test.tsx                          # PR #4 Stage A — NEW
  AppShell.tsx                                      # PR #2
  hooks/
    useResizableSidebar.ts                          # PR #2 (verify wiring), PR #5
    useResizableSidebar.test.ts                     # PR #2 — NEW if missing
    useProjectDialog.ts                             # PR #2 (verify wiring)

src/shared/ui/
  dialog.tsx                                        # PR #3
  popover.tsx                                       # PR #3
  dropdown-menu.tsx                                 # PR #3
  context-menu.tsx                                  # PR #3
  hover-card.tsx                                    # PR #3
  select.tsx                                        # PR #3
  menubar.tsx                                       # PR #3
  navigation-menu.tsx                               # PR #3
  tooltip.tsx                                       # PR #3
  sheet.tsx                                         # PR #3
  alert-dialog.tsx                                  # PR #3
  page-shell.tsx                                    # PR #4 Stage B (if global field-group treatment needed)
  GlobalComposerPill.tsx                            # PR #6

src/features/sidebar/ui/
  Sidebar.tsx                                       # PR #5
  SidebarItemMenu.tsx                               # PR #5 (context-menu wiring)
  SidebarPinnedSection.tsx                          # PR #5 (empty-shell only)
  (sub-components as needed)                        # PR #5

src/features/chat/ui/
  ChatView.tsx                                      # PR #7

src/features/agents/ui/
  AgentsView.tsx                                    # PR #4 Stage B, PR #8
  PersonaCard.tsx                                   # PR #8
  PersonaGallery.tsx                                # PR #8

src/features/skills/ui/
  SkillsView.tsx                                    # PR #4 Stage B, PR #9
  SkillCard.tsx                                     # PR #9
  SkillsGrid.tsx                                    # PR #9

src/features/automations/ui/
  AutomationsView.tsx                               # PR #4 Stage B

src/features/sessions/ui/
  SessionHistoryView.tsx                            # PR #4 Stage B

src/features/home/ui/
  HomeView.tsx                                      # PR #6 (only if redundant-composer investigation reveals issue)
```

---

## Per-PR tasks

Each task represents one PR. Sub-steps are concrete and bite-sized. **Visual changes do not get a TDD step** — Vitest does not exercise CSS. Where structural logic is introduced (PR #2 helper wiring, PR #4 action-slot context, PR #5 collapse behavior), the plan adds real tests.

---

### Task 1: PR #1 — Tokens & globals foundation

**Owner:** Claude subagent
**Branch:** `tulsi/reskin-cleanup-1-tokens` off `origin/main`
**Branch2 commits referenced:** `72c5e93`, `fc05744`, `5072e2b`, `7b44dc1`
**Dependencies:** none
**Load-bearing main work touched:** none (design-system inspector reads tokens but doesn't depend on specific values)

**Files:**
- Modify: `src/shared/styles/globals.css` (1235 LOC — surgical changes only)
- Modify (if a separate Tailwind bridge file exists): `tailwind.config.*`

**Scope summary** (from spec):
- Lighter canvas (`#f5f5f5`)
- Translucent chrome surfaces (opacity 0.8)
- Dot-grid color
- Multi-weight Cash Sans font-faces
- Chip identity colors: `--chip-{chat,project,agent,skill,automation,file}-{bg,fg}`
- Project tint hook (`--project-tint`)
- Backdrop-glass recipe (`--backdrop-composer-glass`)
- Surface card tokens (`--surface-chrome`, `--surface-card-soft`, `--surface-composer`)
- `--color-<name>` bridges for every new token in `@theme inline`

- [ ] **Step 1: Diff branch2's globals.css against current main**

  ```bash
  git fetch origin
  git switch -c tulsi/reskin-cleanup-1-tokens origin/main
  git diff origin/main..origin/tulsi/ui-reskin-branch2 -- src/shared/styles/globals.css > /tmp/globals-diff.patch
  wc -l /tmp/globals-diff.patch
  ```

  Expected: a diff in the hundreds-of-lines range covering the token additions listed above.

- [ ] **Step 2: Hand-port each token group in turn (commit after each group)**

  Walk the diff and apply, *one group at a time*, in this order:

  1. Canvas + dot-grid (`--background-default`, `--background-canvas` if branch2 introduces it, dot-grid color custom property)
  2. Chrome translucency (`--surface-chrome` + `--color-surface-chrome` bridge)
  3. Card softness (`--surface-card-soft`, `--surface-composer`, `--color-*` bridges)
  4. Chip identity (`--chip-chat-bg/fg`, `--chip-project-bg/fg`, `--chip-agent-bg/fg`, `--chip-skill-bg/fg`, `--chip-automation-bg/fg`, `--chip-file-bg/fg` — keep `--chip-file-bg` already at globals.css:411, only add the missing ones, and add all bridges)
  5. Project tint (`--project-tint` custom property — note: this is a hook, not a fixed color; downstream components set it inline)
  6. Backdrop-glass (`--backdrop-composer-glass` recipe — typically a `blur(N)` + `saturate(N)` filter declaration; per `docs/wkwebview-backdrop-filter-report.md`, keep the blur radius modest and increase tint opacity rather than chase large blur values)
  7. Multi-weight Cash Sans `@font-face` rules

  Verify each group in isolation by running the dev app and visually checking the surface that uses that token.

  **Critical:** for every new `--<token>: <value>;` entry in `:root` (and `.dark` block at line 393+), add the corresponding `--color-<token>: var(--<token>);` entry in the `@theme inline` block (around lines 528–700). Tailwind v4 will not emit utilities without the bridge.

- [ ] **Step 3: Light + dark sweep**

  Toggle the design-system inspector (bottom-right, from main's `src/features/design-system/`) between light/dark. Confirm every newly added token has both a light value (`:root`) and a dark value (`.dark`). The chip identity colors in particular need dark variants — branch2's `72c5e93` adds these explicitly.

- [ ] **Step 4: Validation**

  ```bash
  just check
  just test
  ```

  Expected: green. `design-system:audit` should not flag any unbridged tokens.

- [ ] **Step 5: Visual verification gate**

  In `/private/tmp/bloose-main-run` (or wherever the main dev app is running), load Home, Chat, Skills, Agents, Automations, Session history. Expectations:
  - Background reads as `#f5f5f5` (lighter than before)
  - Dot-grid visible on Home canvas
  - Cash Sans weights render where applied (no font fallback)
  - Chip tokens resolve (open the inspector to spot-check)
  - Composer backdrop is frosted, not opaque-card, not see-through

  Note: chip *consumers* (composer chip, sidebar items, etc.) are not changed in this PR — they pick up the new tokens automatically only if they already reference the chip CSS variable names. If a consumer hardcodes a color, that's PR #6/etc.'s problem.

- [ ] **Step 6: Commit**

  ```bash
  git add src/shared/styles/globals.css tailwind.config.*
  git commit -m "feat(tokens): restore branch2 token foundation — chrome, chip identity, project tint, backdrop-glass"
  ```

  Pre-commit hook (lefthook) must pass without `--no-verify`. Do not push.

- [ ] **Step 7: Status report**

  Report to Tulsi: branch name, diff stats, screenshot evidence (or per-surface notes), readiness for push approval.

---

### Task 2: PR #2 — AppShell helpers restoration

**Owner:** Codex
**Branch:** `tulsi/reskin-cleanup-2-appshell-helpers` off `origin/main`
**Branch2 commits referenced:** `9a25494` (already on main; verify what's been retained), `036b18a` (parity batch)
**Dependencies:** none (parallel-safe with PR #1)
**Load-bearing main work touched:** App-shell helpers (the refactor *is* the load-bearing work — the goal of this PR is to ensure main's structure matches what branch2 expects downstream PRs to consume)

**Files:**
- Modify: `src/app/AppShell.tsx`
- Modify: `src/app/ui/AppShellLayout.tsx`
- Modify: `src/app/ui/AppShellContent.tsx`
- Verify (and refactor consumers if needed): `src/app/hooks/useResizableSidebar.ts`, `src/app/hooks/useProjectDialog.ts`, any `settingsSectionUrl` helper

**Scope summary:** Pure refactor. Re-integrate `useResizableSidebar`, `useProjectDialog`, and `settingsSectionUrl` helpers as consumed by `AppShell.tsx`. No visual change. The point is to unblock PR #4's TopBar work, which depends on these helpers being present on the AppShell.

- [ ] **Step 1: Audit current state**

  ```bash
  git switch -c tulsi/reskin-cleanup-2-appshell-helpers origin/main
  grep -n "useResizableSidebar\|useProjectDialog\|settingsSectionUrl" src/app/AppShell.tsx src/app/ui/*.tsx
  ```

  Confirm whether each helper is already wired into `AppShell.tsx` or only defined in `src/app/hooks/`. If a helper is defined but not consumed, identify the inline duplication on main that should be replaced.

- [ ] **Step 2: Diff branch2's AppShell against main**

  ```bash
  git diff origin/main..origin/tulsi/ui-reskin-branch2 -- src/app/AppShell.tsx src/app/ui/ src/app/hooks/ > /tmp/appshell-diff.patch
  ```

  Identify hunks that:
  - Replace inline sidebar-resize state on main with `useResizableSidebar`
  - Replace inline project-dialog state with `useProjectDialog`
  - Centralize settings URL construction via `settingsSectionUrl`

- [ ] **Step 3: Port the inlining-removal hunks, one helper at a time**

  For each of the three helpers:
  1. Identify the inline duplication on main.
  2. Replace it with the existing helper call.
  3. Run `just check && just test` after each helper.
  4. Verify navigation/sidebar resize/project dialog still work in the dev app.

- [ ] **Step 4: Backfill tests for `useResizableSidebar` if missing**

  ```bash
  ls src/app/hooks/useResizableSidebar.test.ts 2>/dev/null || echo "missing"
  ```

  If missing, add a test that covers the load-bearing behaviors PR #5 will rely on: collapse-to-zero (or the "fully collapsed" state — the test asserts the hook can yield a state where the sidebar is not present at all), expand-back-to-default-width, and width persistence.

  ```ts
  // src/app/hooks/useResizableSidebar.test.ts
  import { renderHook, act } from "@testing-library/react";
  import { describe, it, expect } from "vitest";
  import { useResizableSidebar } from "./useResizableSidebar";

  describe("useResizableSidebar", () => {
    it("starts at the default width", () => {
      const { result } = renderHook(() => useResizableSidebar());
      expect(result.current.width).toBeGreaterThan(0);
    });

    it("collapses to a fully-collapsed state when toggled closed", () => {
      const { result } = renderHook(() => useResizableSidebar());
      act(() => result.current.toggleCollapse());
      expect(result.current.isCollapsed).toBe(true);
    });

    it("restores the previous width when re-opened", () => {
      const { result } = renderHook(() => useResizableSidebar());
      const initial = result.current.width;
      act(() => result.current.toggleCollapse());
      act(() => result.current.toggleCollapse());
      expect(result.current.width).toBe(initial);
    });
  });
  ```

  Run: `just test -- useResizableSidebar.test.ts` — expected PASS. If the existing hook does not yet support `isCollapsed`, this is the seam PR #5 needs; either extend it now (preferred — it makes PR #5 a smaller diff) or note the gap for PR #5 to fill.

- [ ] **Step 5: Validation**

  ```bash
  just check
  just test
  ```

  Expected: green. No new tests should regress.

- [ ] **Step 6: Visual no-change check**

  Load the dev app. Sidebar resize, project creation, settings navigation should all still work *exactly* as before. This is a refactor — visible behavior identical.

- [ ] **Step 7: Commit**

  ```bash
  git add src/app/
  git commit -m "refactor(app-shell): re-integrate useResizableSidebar, useProjectDialog, settingsSectionUrl helpers"
  ```

  Do not push.

- [ ] **Step 8: Status report**

  Report: which inline duplications were removed, what tests were added/updated, any seams the executor left for PR #5.

---

### Task 3: PR #3 — Overlay primitive surface restoration

**Owner:** Claude subagent
**Branch:** `tulsi/reskin-cleanup-3-overlay-primitives` off `origin/main`
**Branch2 commits referenced:** `eaceacb` (overlay surface system + Sheet-based editors), `613bc0c` (restore page actions and soften cards)
**Dependencies:** PR #1 (tokens) merged
**Load-bearing main work touched:** Design system inspector should still render `surface-overlay` tokens correctly after the fix.

**Files (all under `src/shared/ui/`):**
- `dialog.tsx`, `popover.tsx`, `dropdown-menu.tsx`, `context-menu.tsx`, `hover-card.tsx`, `select.tsx`, `menubar.tsx`, `navigation-menu.tsx`, `tooltip.tsx`, `sheet.tsx`, `alert-dialog.tsx`

**Scope summary:** Unify the surface class across all eleven overlay primitives so they paint opaque, bordered, and shadow-free. Goal: every primitive consumes the same surface token (`bg-surface-overlay`), matching branch2's `eaceacb`.

**Diagnostic facts from PR #1 visual verification (2026-05-20):**

The spec's framing ("regression in the popover surface tokens" — singular) was a single-cause story. Reality on main is heterogeneous — each primitive points at a different class:

| Primitive | Surface class on main | Token state | Renders |
|---|---|---|---|
| `Popover` | `bg-surface-overlay` | defined by PR #1 | ✅ opaque (model picker confirms) |
| `Dialog` | `bg-background` + `shadow-modal` + `border` | `--background` defined | washed/translucent (root cause not at token layer) |
| `Sheet` | `bg-background` + `border-l/r/t/b` | `--background` defined | washed/translucent (same — Create Project, New Agent, PersonaEditor, SkillEditor) |
| `ContextMenu` | `bg-background-popover` + `shadow-popover` + `border` | **`--background-popover` undefined on main** | transparent (sidebar item menu confirms) |
| `DropdownMenu` | `bg-background-popover` + `shadow-popover` + `border` | **`--background-popover` undefined** | transparent (downstream of menu paths that hit this) |
| Others (`HoverCard`, `Select`, `Menubar`, `NavigationMenu`, `Tooltip`, `AlertDialog`) | mixed — read each | various | unknown — verify per file |

The fix shape:

1. **Class unification.** Swap every primitive's surface class to `bg-surface-overlay`. The Popover reference (which works) is the template. Remove `bg-background`, `bg-background-popover`, and any other surface class on these eleven files.
2. **Delete dead-token references.** `--background-popover` is undefined in `globals.css` — `bg-background-popover` is currently a no-op. Do not define the token; remove every `bg-background-popover` reference.
3. **Drop drop-shadow utilities.** `Dialog` has `shadow-modal` (`globals.css:287` light = `0 20px 60px rgba(0,0,0,0.2)`, line 509 dark = `0 20px 60px rgba(0,0,0,0.6)`). Remove `shadow-modal` from the Dialog primitive. PR #1 already set `--shadow-popover: none` (which neutralizes ContextMenu/DropdownMenu/Popover shadow refs) — preserve that. The `shadow-modal` token itself can stay defined; just stop referencing it from the primitives.
4. **Sheet's washed render needs DOM-level diagnosis.** `bg-background` resolves to `var(--color-white)` (defined at globals.css:221), yet Sheet content paints translucent. Cause is *not* at the token layer. Hypotheses to test in devtools: a stuck `data-[state=open]:fade-in-0` animation (final opacity never reaches 1), a parent with reduced opacity, or `mix-blend-mode` inheritance. Once diagnosed, the unified `bg-surface-overlay` swap should resolve it; if not, name the actual cause in the fix.
5. **Borders.** Every primitive should keep its `border` utility — elevation comes from border + token contrast, not shadow.

**Reference:** branch2's `eaceacb` ("overlay surface system + Sheet-based editors") is the authoritative shape. Hand-port its className hunks, do not cherry-pick.

- [ ] **Step 1: Confirm the baseline + grep current surface classes**

  ```bash
  # Stacked-branch mode: PR #1 is NOT on origin/main yet. Branch off PR #1's branch directly.
  git fetch origin
  git switch -c tulsi/reskin-cleanup-3-overlay-primitives tulsi/reskin-cleanup-1-tokens
  git log --oneline -3   # Expect: PR #1's commit 2336eb3 at top

  # Confirm the diagnostic table above is still accurate on current main
  for f in dialog popover dropdown-menu context-menu hover-card select menubar navigation-menu tooltip sheet alert-dialog; do
    echo "=== $f ===";
    grep -nE "bg-(surface-overlay|background|popover|card)" "src/shared/ui/$f.tsx" | head -5;
    grep -nE "shadow-(modal|popover|md|lg|xl)" "src/shared/ui/$f.tsx" | head -3;
  done > /tmp/primitives-baseline.txt
  cat /tmp/primitives-baseline.txt
  ```

  Cross-check against the diagnostic table in the scope summary. If a primitive's surface class on main differs from what's in the table, update the plan inline before proceeding — don't paper over the drift.

- [ ] **Step 2: Diagnose Sheet's washed render**

  Before swapping classes, confirm *why* Sheet renders translucent despite `bg-background` being defined. Open the dev app, open New Agent (Sheet-based editor), use devtools (right-click → Inspect Element in the WKWebView debug pane) to inspect `[data-slot=sheet-content]`:

  - Computed `background-color` — is it `rgb(255, 255, 255)` or something with low alpha?
  - Computed `opacity` — is it `1`?
  - `mix-blend-mode` on the element or any ancestor — should be `normal`
  - Animation state — is `data-state=open` set? Are `--tw-enter-opacity` / `--tw-enter-scale` resolving correctly?
  - Z-stack — is `[data-slot=sheet-overlay]` (the `bg-black/50`) painting *above* the content?

  Document the cause. The unified `bg-surface-overlay` swap in Step 3 should fix it; if devtools reveals a different cause (e.g. a parent `opacity: 0.5`), name it and adjust the fix.

- [ ] **Step 3: Reference branch2's `eaceacb`**

  ```bash
  git show eaceacb -- src/shared/ui/dialog.tsx src/shared/ui/popover.tsx src/shared/ui/dropdown-menu.tsx \
                       src/shared/ui/context-menu.tsx src/shared/ui/hover-card.tsx src/shared/ui/select.tsx \
                       src/shared/ui/menubar.tsx src/shared/ui/navigation-menu.tsx src/shared/ui/tooltip.tsx \
                       src/shared/ui/sheet.tsx src/shared/ui/alert-dialog.tsx > /tmp/eaceacb-primitives.patch
  wc -l /tmp/eaceacb-primitives.patch
  ```

  Confirm branch2 unifies on `bg-surface-overlay` (or whatever surface class branch2 chose — the unification, not the exact class name, is the principle). If branch2 picked a different token, match it.

- [ ] **Step 4: Apply the unified surface class to Dialog first, then verify**

  Modify `src/shared/ui/dialog.tsx:72` — swap `bg-background` → `bg-surface-overlay`, remove `shadow-modal`, keep `border` and `rounded-modal`. Run dev app, reopen any Dialog-based surface. Confirm opaque + bordered + no drop shadow.

  ```bash
  ./bin/just check
  ```

- [ ] **Step 5: Roll the same swap across the remaining ten primitives**

  For each file in turn, swap whatever surface class it currently uses to `bg-surface-overlay`, and remove any `shadow-*` utility:

  - `popover.tsx` — already `bg-surface-overlay`; verify nothing else needs change (Popover is the reference)
  - `sheet.tsx` — `bg-background` → `bg-surface-overlay`; verify Step 2's diagnosis is resolved by this swap
  - `dropdown-menu.tsx` — `bg-background-popover` → `bg-surface-overlay` on **both** the content slot AND the sub-content (currently at lines 67 + 309)
  - `context-menu.tsx` — `bg-background-popover` → `bg-surface-overlay` on **both** the content slot AND the sub-content (lines 86 + 103)
  - `hover-card.tsx`, `select.tsx`, `menubar.tsx`, `navigation-menu.tsx`, `tooltip.tsx`, `alert-dialog.tsx` — read each, swap surface class to `bg-surface-overlay`, remove shadow utilities

  Visually verify each surface in the dev app after every file.

- [ ] **Step 6: Verify the no-shadows rule + delete dead-token references**

  ```bash
  grep -nE "shadow-(modal|popover|md|lg|xl|2xl)" src/shared/ui/dialog.tsx src/shared/ui/popover.tsx \
    src/shared/ui/dropdown-menu.tsx src/shared/ui/context-menu.tsx src/shared/ui/hover-card.tsx \
    src/shared/ui/select.tsx src/shared/ui/menubar.tsx src/shared/ui/navigation-menu.tsx \
    src/shared/ui/tooltip.tsx src/shared/ui/sheet.tsx src/shared/ui/alert-dialog.tsx

  grep -rn "bg-background-popover" src/
  ```

  Expected: no `shadow-modal` or `shadow-md/lg/xl/2xl` on any content slot. `shadow-popover` refs are inert (PR #1 set the token to `none`), but per the rule prefer not referencing them at all. `bg-background-popover` should be gone from `src/` entirely — it was undefined dead code.

- [ ] **Step 7: Regenerate design system manifest**

  ```bash
  pnpm design-system:generate
  ```

  Pre-commit hook runs `design-system:audit`; this avoids the lefthook block.

- [ ] **Step 8: Validation**

  ```bash
  ./bin/just check
  ./bin/just test
  ```

  Expected: green. Snapshot tests for any primitive surface (search `src/shared/ui/**/*.test.tsx` and any feature test that snapshots a modal/sheet/menu) will likely diff because surface classes change — review each snapshot diff, do not blindly accept.

- [ ] **Step 9: Visual verification gate**

  Walk through the spec's screenshot reference list **plus** the heterogeneous-primitive surfaces from the diagnostic table:

  - **Dialog-based:** any centered confirmation/alert in the app (search for `<Dialog ` usages)
  - **Sheet-based:** New Agent (PersonaEditor), New Skill (SkillEditor), Create Project (CreateProjectDialog)
  - **DropdownMenu-based:** the model picker is *already* working via Popover — find an actual DropdownMenu consumer (header overflow menus, etc.) and verify it now reads opaque too
  - **ContextMenu-based:** sidebar session-row right-click menu (Rename / Mark unread / Archive)
  - **Popover:** model picker on chat composer — should remain opaque (regression check)
  - **Tooltip, HoverCard, AlertDialog, Select, Menubar, NavigationMenu:** spot-check at least one consumer of each if one exists in the app today

  Confirm each: opaque, bordered, no drop shadow, no washed/translucent paint.

- [ ] **Step 10: Commit**

  ```bash
  git add src/shared/ui/
  git commit -m "fix(ui): unify overlay primitives on bg-surface-overlay; drop shadow-modal and dead bg-background-popover refs"
  ```

  Do not push.

- [ ] **Step 11: Status report**

  Report:
  1. The diagnosed Sheet-washed-render root cause from Step 2 (token vs animation vs blend-mode vs parent opacity)
  2. The set of primitives that needed swapping (likely 10 of 11; Popover should already be correct)
  3. Any primitive whose branch2 form diverges from the unified `bg-surface-overlay` recipe — flag for Tulsi
  4. Snapshot test files that updated
  5. Deferred: editor-modal Figma styling (Alex's designs, out of scope per spec)

---

### Task 4: PR #4 — Chrome system refactor + PageHeader migration

**Owner:** Codex (Stage A — structural / TopBar / action slot mechanism); Claude subagent (Stage B — per-page migrations once action slot exists). The plan keeps them as two commits inside one PR for bisectability.
**Branch:** `tulsi/reskin-cleanup-4-chrome-pageheader` off `origin/main`
**Branch2 commits referenced:** `5072e2b` (chrome surfaces, already in PR #1), `a5ee6fd` (topbar action slot + bottom fade + card fill), `d524f71` (Agents empty-state strip + lighter TopBar page label), `14e5a1d` (editor overlay polish + chrome-panel top-edge alignment)
**Dependencies:** PR #1 (tokens), PR #2 (helpers)
**Load-bearing main work touched:** None preserved-by-deletion. Confirm in PR description that the design-system inspector and backend layout API are untouched.

**Files:**
- Stage A: `src/app/ui/TopBar.tsx` (199 LOC), `src/app/ui/AppShellLayout.tsx` (63 LOC), `src/app/ui/AppShellContent.tsx`, NEW `src/app/ui/TopBarActions.tsx`, NEW `src/app/ui/TopBarActions.test.tsx`, possibly `src/shared/ui/page-shell.tsx` (178 LOC)
- Stage B: `src/features/agents/ui/AgentsView.tsx` (418 LOC), `src/features/skills/ui/SkillsView.tsx` (304 LOC), `src/features/automations/ui/AutomationsView.tsx` (2205 LOC), `src/features/sessions/ui/SessionHistoryView.tsx` (607 LOC)

#### Stage A — Chrome infrastructure

- [ ] **Step 1: Branch + audit current TopBar**

  ```bash
  git switch -c tulsi/reskin-cleanup-4-chrome-pageheader origin/main
  # PR #1 and PR #2 must be merged.
  wc -l src/app/ui/TopBar.tsx src/app/ui/AppShellLayout.tsx
  ```

  Read TopBar.tsx in full; identify the height value, breadcrumb hook (if any), and where action slots could mount.

- [ ] **Step 2: Diff branch2's TopBar**

  ```bash
  git diff origin/main..origin/tulsi/ui-reskin-branch2 -- src/app/ui/TopBar.tsx src/app/ui/AppShellLayout.tsx > /tmp/topbar-diff.patch
  ```

  Identify the action-slot mechanism (likely a React Context + portal pair, or a Zustand store keyed by route).

- [ ] **Step 3: Implement `TopBarActions` context + portal**

  Create `src/app/ui/TopBarActions.tsx`. The simplest mechanism that survives review: a Context that holds a ReactNode slot and a setter, with a `<TopBarActionSlot>` outlet rendered inside TopBar and a `useTopBarActions(node)` hook that pages call from a `useEffect` to mount/unmount their actions.

  ```tsx
  // src/app/ui/TopBarActions.tsx
  import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

  type Setter = (node: ReactNode | null) => void;
  const TopBarActionsContext = createContext<{ node: ReactNode | null; setNode: Setter }>({
    node: null,
    setNode: () => {},
  });

  export function TopBarActionsProvider({ children }: { children: ReactNode }) {
    const [node, setNode] = useState<ReactNode | null>(null);
    return (
      <TopBarActionsContext.Provider value={{ node, setNode }}>
        {children}
      </TopBarActionsContext.Provider>
    );
  }

  export function TopBarActionSlot() {
    const { node } = useContext(TopBarActionsContext);
    return <>{node}</>;
  }

  export function useTopBarActions(node: ReactNode) {
    const { setNode } = useContext(TopBarActionsContext);
    useEffect(() => {
      setNode(node);
      return () => setNode(null);
    }, [node, setNode]);
  }
  ```

  Wrap the app tree at the right level (likely inside `AppShell.tsx` so every page below it shares one slot).

- [ ] **Step 4: Test `TopBarActions`**

  Create `src/app/ui/TopBarActions.test.tsx`:

  ```tsx
  import { render, screen } from "@testing-library/react";
  import { describe, it, expect } from "vitest";
  import {
    TopBarActionsProvider,
    TopBarActionSlot,
    useTopBarActions,
  } from "./TopBarActions";

  function PageUsingActions({ label }: { label: string }) {
    useTopBarActions(<button type="button">{label}</button>);
    return <div>page body</div>;
  }

  describe("TopBarActions", () => {
    it("mounts a page's actions into the slot", () => {
      render(
        <TopBarActionsProvider>
          <TopBarActionSlot />
          <PageUsingActions label="Import" />
        </TopBarActionsProvider>,
      );
      expect(screen.getByRole("button", { name: "Import" })).toBeInTheDocument();
    });

    it("clears actions when the page unmounts", () => {
      const { rerender } = render(
        <TopBarActionsProvider>
          <TopBarActionSlot />
          <PageUsingActions label="Import" />
        </TopBarActionsProvider>,
      );
      rerender(
        <TopBarActionsProvider>
          <TopBarActionSlot />
        </TopBarActionsProvider>,
      );
      expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
    });
  });
  ```

  Run: `pnpm vitest run src/app/ui/TopBarActions.test.tsx --bail 1 --reporter=verbose --testTimeout=15000` — expected PASS.

- [ ] **Step 5: Update TopBar to render the slot + breadcrumb**

  Modify `src/app/ui/TopBar.tsx`:
  - Set height to 56px (branch2 value; verify against `d06a85b` and `a5ee6fd`)
  - Handle traffic-light inset (macOS first 80px)
  - Render breadcrumb `Tulsi's World / <Section>` (section name from the active route; pull from existing route state)
  - Render `<TopBarActionSlot />` at the right edge

  Reference `a5ee6fd` for class composition:

  ```bash
  git show a5ee6fd -- src/app/ui/TopBar.tsx
  ```

- [ ] **Step 6: Validate Stage A**

  ```bash
  just check
  just test
  ```

  Visual: open dev app. TopBar should show breadcrumb. The action slot is empty (no pages opt in yet); confirm it renders no debris when empty.

- [ ] **Step 7: Commit Stage A**

  ```bash
  git add src/app/ src/app/ui/
  git commit -m "feat(chrome): TopBar action-slot context, breadcrumb, traffic-light inset"
  ```

#### Stage B — Per-page migrations

For each list page, the migration is the same shape: remove the `<PageHeader>`, opt the page into `useTopBarActions` with its action buttons.

- [ ] **Step 8: Migrate Agents (`AgentsView.tsx`)**

  - Remove the inline `PageHeader` (title + subtitle) — branch2's `d524f71` strips the empty-state subtitle, matching this.
  - Remove dead affordances: search input, sort, grid-view toggle buttons.
  - Move `+New Agent` and `Import` buttons into a `useTopBarActions` call.
  - Run `just check` and visual-verify against the Agents screenshot.

  ```bash
  git show d524f71 -- src/features/agents/ui/AgentsView.tsx
  ```

- [ ] **Step 9: Migrate Skills (`SkillsView.tsx`)**

  - Remove `<PageHeader>`.
  - Move `+New Skill`, `Import`, `Refresh` into `useTopBarActions`.
  - Run `just check`, visual-verify.

- [ ] **Step 10: Migrate Automations index (`AutomationsView.tsx`)**

  This file is 2205 LOC. Be surgical:
  - Identify the list-index `<PageHeader>` (likely in the top render block, not the detail panel).
  - Remove it.
  - Move `Add automation` into `useTopBarActions`.
  - **Do not touch the right-side detail pane** in this commit unless the field-group treatment is clearly a global PageShell concern (spec PR #4 open question #3). If it's local, note it for a follow-up.
  - Run `just check`, visual-verify.

- [ ] **Step 11: Migrate Session history (`SessionHistoryView.tsx`)**

  - Remove the `<PageHeader>`.
  - Replace the title with the giant inline placeholder pattern ("Search sessions…" as faded large text). Reference the equivalent pattern in main's Search page (PR #111).
  - Any page actions → `useTopBarActions`.
  - Run `just check`, visual-verify.

- [ ] **Step 12: Audit Automation detail right-pane field groups**

  Open the Automation detail view in dev app. If field groups still show heavy borders that look out of place against the new chrome:
  - If the treatment lives in `src/shared/ui/page-shell.tsx` and affects multiple detail views: fold into this PR.
  - If local to `AutomationBuilderPanel.tsx`: note as a follow-up and leave for later — do not balloon this PR.

- [ ] **Step 13: Stage B validation**

  ```bash
  just check
  just test
  ```

  Expected: green. Snapshot tests on the four pages may need updates — review carefully.

- [ ] **Step 14: Stage B visual gate**

  Walk all four pages in the dev app, confirm against spec screenshots: Skills, Agents, Home (which inherits the TopBar but otherwise unchanged here), Create automation, Automation Opened, Automations Page, Session history page.

- [ ] **Step 15: Commit Stage B**

  ```bash
  git add src/features/agents/ src/features/skills/ src/features/automations/ src/features/sessions/ src/shared/ui/page-shell.tsx
  git commit -m "refactor(pages): remove inline PageHeader on Agents/Skills/Automations/Session history; mount page actions in TopBar slot"
  ```

  Do not push. Total PR diff target: 200–400 LOC per spec. If the diff is >500 LOC, suggest splitting into 4a (infra) and 4b (page migrations) per spec risk #1.

- [ ] **Step 16: Status report**

  Report: TopBar action-slot mechanism design, list of pages migrated, any field-group polish deferred, diff size.

---

### Task 5: PR #5 — Sidebar fully-collapse + restoration

**Owner:** Codex (Part A — collapse behavior, prop interface, session-item menu wiring); Claude subagent (Part B — mask-fade, pinned-section shell, item styling)
**Branch:** `tulsi/reskin-cleanup-5-sidebar` off `origin/main`
**Branch2 commits referenced:** `d06a85b` (sidebar + TopBar reskin per Figma 891:11342), `5d2203e` (sidebar mask-fade + outline-flat pill)
**Dependencies:** PR #1, PR #2, PR #3 (for restored context-menu surface)
**Load-bearing main work touched:** None. The pinned section is a *visual shell only* in this PR — the layout API integration for pinning v2 is explicitly out of scope per spec.

**Files:**
- Modify: `src/features/sidebar/ui/Sidebar.tsx` (340 LOC)
- Modify: `src/features/sidebar/ui/SidebarItemMenu.tsx`, `SidebarPinnedSection.tsx`, `SidebarNavItem.tsx`, `SidebarChatRow.tsx`, `SidebarRecentsSection.tsx`, `SidebarProjectsSection.tsx`, `SidebarProjectSection.tsx`, `SidebarProjectList.tsx` (as needed)
- Modify: `src/app/hooks/useResizableSidebar.ts` (extend for full-collapse if not already done in PR #2)

#### Part A — Fully-collapse regression

- [ ] **Step 1: Branch + audit current collapse behavior**

  ```bash
  git switch -c tulsi/reskin-cleanup-5-sidebar origin/main
  grep -n "isCollapsed\|collapsed\|collapse" src/app/hooks/useResizableSidebar.ts src/features/sidebar/ui/Sidebar.tsx src/app/ui/AppShellLayout.tsx
  ```

  Verify whether main's current "compact icon rail when closed" behavior is in `Sidebar.tsx` (rendering a slim rail) or `AppShellLayout.tsx` (laying out a minimum-width column).

- [ ] **Step 2: Diff branch2's sidebar**

  ```bash
  git diff origin/main..origin/tulsi/ui-reskin-branch2 -- src/features/sidebar/ src/app/hooks/useResizableSidebar.ts > /tmp/sidebar-diff.patch
  ```

  Identify the full-collapse hunks: typically a guard at the top of `Sidebar.tsx` `if (isCollapsed) return null;` plus a layout adjustment so the canvas reclaims the space.

- [ ] **Step 3: Implement full-collapse**

  - In `Sidebar.tsx`: early-return `null` when the collapsed state is true.
  - In `AppShellLayout.tsx`: when collapsed, the layout should let the canvas span the full width (no minimum icon-rail column).
  - In `useResizableSidebar.ts`: ensure the `isCollapsed` flag is exposed (added in PR #2 Step 4 if not already present).

- [ ] **Step 4: Test full-collapse behavior**

  Extend `src/features/sidebar/ui/__tests__/Sidebar.test.tsx` (or create it):

  ```tsx
  import { render } from "@testing-library/react";
  import { describe, it, expect } from "vitest";
  import { Sidebar } from "../Sidebar";

  describe("Sidebar collapse", () => {
    it("renders nothing when collapsed", () => {
      const { container } = render(<Sidebar isCollapsed />);
      expect(container).toBeEmptyDOMElement();
    });
  });
  ```

  Run: `pnpm vitest run src/features/sidebar/ui/__tests__/Sidebar.test.tsx --bail 1 --reporter=verbose --testTimeout=15000` — expected PASS.

  Note: Sidebar's actual props/contract may differ from `isCollapsed` directly. Adjust the test to match the real prop interface (read the file before writing the test). The point is: a test that proves the early-return.

- [ ] **Step 5: Visual verify Part A**

  In dev app, hit the sidebar collapse control on every page (Home, Chat, Skills, Agents, Automations, Sessions, Search, Settings). Confirm the sidebar disappears entirely — only the traffic-light area / chrome dots remain. Open and close — width should restore (covered by PR #2's `useResizableSidebar` test).

#### Part B — Restore lost features

- [ ] **Step 6: Restore the sidebar item list**

  Reference branch2's `d06a85b`. Confirm the item list contains: New chat, Home, Agents, Skills, Automations, Session history, Settings. Hand-port any missing items from `Sidebar.tsx` on branch2.

  Each new `<button>` element needs `type="button"`.

- [ ] **Step 7: Restore project section + chats grouping**

  Branch2 groups projects and chats. Port the structural grouping (the visual treatment lives in `SidebarProjectsSection.tsx`, `SidebarProjectList.tsx`, `SidebarChatRow.tsx`, `SidebarRecentsSection.tsx` — check each).

- [ ] **Step 8: Pinned-section empty shell**

  Render `SidebarPinnedSection.tsx` as a reserved-space shell only — no data integration. The component renders the section header ("Pinned") and an empty area where pinned items will appear after the future pinning-v2 PR (see spec Out of scope follow-ups).

  Do not import the layout API. Do not import `useHomeLayoutQuery`. Empty list, empty array.

- [ ] **Step 9: Mask-fade treatment**

  Reference `5d2203e`. Apply the mask-fade gradient that tapers the bottom edge of the scrollable sidebar content.

  ```bash
  git show 5d2203e -- src/features/sidebar/ui/Sidebar.tsx
  ```

  Likely a Tailwind utility `mask-image: linear-gradient(...)` or a wrapper `<BottomFade>` (already in main at `src/shared/ui/BottomFade.tsx`). Reuse `BottomFade` if shape matches.

- [ ] **Step 10: Wire session-item context menu**

  Sidebar session items get a right-click / "..." context menu with: Rename, Mark unread, Archive. The popover primitive surface was restored in PR #3 — this step is just the trigger and items.

  Wire in `SidebarItemMenu.tsx` (already exists). Confirm each menu item has `type="button"`. Confirm the popover renders opaque (PR #3 must already be merged).

- [ ] **Step 11: Validation**

  ```bash
  just check
  just test
  ```

  Expected: green. If `AppShell.navigation.test.tsx` was red on branch2 due to upstream churn and is touched here, fix or quarantine within scope.

- [ ] **Step 12: Visual gate**

  Spec screenshot reference: sidebar collapse behavior visible on every page. Walk Home, Chat, Skills, Agents, Sessions, Automations, Settings. Confirm:
  - Sidebar fully hides when collapsed (Part A)
  - All seven nav items present (Part B)
  - Pinned section header visible, empty
  - Mask-fade at the bottom edge
  - Session-item context menu opaque + ordered Rename / Mark unread / Archive

- [ ] **Step 13: Commit**

  ```bash
  git add src/features/sidebar/ src/app/
  git commit -m "feat(sidebar): full-collapse + restore item list, project grouping, pinned shell, mask-fade, item menu"
  ```

  Do not push.

- [ ] **Step 14: Status report**

  Report: collapse behavior verified across all pages, list of items restored, pinned section is shell-only, item menu wiring.

---

### Task 6: PR #6 — Composer pill enrichment

**Owner:** Claude subagent (chip rendering, model UX). Codex if Step 1's investigation reveals a structural issue on Home.
**Branch:** `tulsi/reskin-cleanup-6-composer` off `origin/main`
**Branch2 commits referenced:** `6c99bfe` (port universal search + global composer from visual-design — most already on main via PR #111; port only the delta)
**Dependencies:** PR #1 (chip tokens), PR #3 (selector menu surfaces)
**Load-bearing main work touched:** Backend layout state (PR #109 + #120). Confirm `HomeView` continues to hydrate from the layout API; do not regress to localStorage.

**Files:**
- Modify: `src/shared/ui/GlobalComposerPill.tsx` (797 LOC — surgical)
- Modify (only if Step 1 investigation reveals issue): `src/features/home/ui/HomeView.tsx` (42 LOC), `src/features/home/ui/HomeComposer.tsx` (79 LOC)

**Scope summary:** Enrich composer with chip rendering (file/chat/project/agent/skill chips via `--chip-*` tokens), model grouping by provider in the selector, `Cmd+;` voice shortcut, glass-surface backdrop. Investigate the redundant-composer-on-Home regression; fix only if still present.

- [ ] **Step 1: Investigate the redundant-composer-on-Home regression**

  ```bash
  git switch -c tulsi/reskin-cleanup-6-composer origin/main
  grep -n "Composer\|GlobalComposerPill" src/features/home/ui/HomeView.tsx src/features/home/ui/HomeComposer.tsx src/app/ui/AppShellLayout.tsx src/app/ui/AppShellContent.tsx
  ```

  Load Home in the dev app and look for two composers. Possible outcomes:
  - **Already fixed by Kalvin's PR #120** — HomeView is now backend-hydrated and may have dropped its inline composer. Confirm by reading the file end-to-end. Skip the structural fix.
  - **Still present** — HomeView renders `HomeComposer` and AppShell also renders `GlobalComposerPill`. Remove the inline `HomeComposer` import + usage from `HomeView.tsx` and confirm the global composer is the only one shown.

  Report findings before proceeding to Step 2.

- [ ] **Step 2: Diff branch2's composer**

  ```bash
  git diff origin/main..origin/tulsi/ui-reskin-branch2 -- src/shared/ui/GlobalComposerPill.tsx > /tmp/composer-diff.patch
  wc -l /tmp/composer-diff.patch
  ```

  Identify the chip-rendering hunks, model-grouping hunks, and shortcut hunks.

- [ ] **Step 3: Chip-rendering — static lookup map**

  Per the Tailwind v4 dynamic-class warning in conventions: do not write `` className={`bg-chip-${kind}-bg`} ``. Add:

  ```ts
  const CHIP_BG_BY_KIND = {
    chat: "bg-chip-chat-bg",
    project: "bg-chip-project-bg",
    agent: "bg-chip-agent-bg",
    skill: "bg-chip-skill-bg",
    automation: "bg-chip-automation-bg",
    file: "bg-chip-file-bg",
  } as const;
  const CHIP_FG_BY_KIND = {
    chat: "text-chip-chat-fg",
    project: "text-chip-project-fg",
    agent: "text-chip-agent-fg",
    skill: "text-chip-skill-fg",
    automation: "text-chip-automation-fg",
    file: "text-chip-file-fg",
  } as const;
  ```

  Apply these via `cn()` in the chip renderer. The `ComposerChip` shared primitive already exists at `src/features/chat/ui/ComposerChip.tsx` — extend it, do not inline.

- [ ] **Step 4: Model grouping by provider in the selector**

  Modify the model-list rendering in `GlobalComposerPill.tsx` (or its sub-component if model-picker logic is delegated) to render models grouped by their `provider` field. This is a pure render change against the existing model data shape — no new API.

  Reference branch2's `6c99bfe` for the grouping treatment.

- [ ] **Step 5: Add `Cmd+;` voice shortcut**

  Wire a `Cmd+;` keyboard shortcut to whatever voice trigger already exists in main's composer (search for `voice` references). If main has no voice handler at all, defer this sub-step and note it as out-of-scope for the regression cleanup.

  Use `useGlobalAppShortcuts` (already at `src/app/hooks/useGlobalAppShortcuts.ts`) or the equivalent pattern in `GlobalComposerPill.tsx`.

- [ ] **Step 6: Glass-surface backdrop**

  The `--backdrop-composer-glass` token landed in PR #1. Apply it to the composer's backdrop element. Per `docs/wkwebview-backdrop-filter-report.md`: keep blur radius modest, lean on tint opacity for legibility. Add the `-webkit-backdrop-filter` prefixed declaration alongside the standard one.

- [ ] **Step 7: Validation**

  ```bash
  just check
  just test
  ```

  Expected: green.

- [ ] **Step 8: Visual gate**

  Spec screenshot reference:
  - **Selector menu on chat composer** — model groups by provider, opaque per PR #3
  - **Home screen** — only one composer visible (or two confirmed-acceptable from Step 1)

  Open dev app Chat: attach a file, mention a chat/project/agent/skill, observe chip identity colors. Open model picker, observe provider groups. Press `Cmd+;`, observe voice trigger.

- [ ] **Step 9: Commit**

  ```bash
  git add src/shared/ui/GlobalComposerPill.tsx src/features/chat/ui/ComposerChip.tsx src/features/home/ui/
  git commit -m "feat(composer): chip identity rendering, provider grouping, Cmd+; voice, glass backdrop; drop redundant Home composer if present"
  ```

  Do not push.

- [ ] **Step 10: Status report**

  Report: outcome of redundant-composer investigation, chip lookup map added, model grouping in place, voice shortcut wired or deferred.

---

### Task 7: PR #7 — Chat surface card + glass

**Owner:** Claude subagent
**Branch:** `tulsi/reskin-cleanup-7-chat` off `origin/main`
**Branch2 commits referenced:** `7b44dc1` (tokenize chat surface against reskin tokens)
**Dependencies:** PR #1
**Load-bearing main work touched:** None. `MessageBubble.test.tsx` is red on branch2 from upstream churn — main's tests must stay green.

**Files:**
- Modify: `src/features/chat/ui/ChatView.tsx` (213 LOC)
- Modify (possibly): `src/features/chat/ui/MessageTimeline.tsx`, `src/features/chat/ui/ChatInput.tsx` (composer container)

**Scope summary:** Wrap chat message timeline in `rounded-card-chat bg-surface-card`. Make composer absolutely positioned with `translate-y-1/2` overlap and backdrop glass filter. Outer wrapper `pointer-events-none` so card is scrollable; inner glass re-enables pointer events. Empty-state when `messages.length === 0`. `pb-12` for McpApp tail, `pb-24` otherwise. Rename internal tail-detection helper to `isMcpAppTail()` (clarity only).

- [ ] **Step 1: Branch + diff**

  ```bash
  git switch -c tulsi/reskin-cleanup-7-chat origin/main
  git diff origin/main..origin/tulsi/ui-reskin-branch2 -- src/features/chat/ui/ChatView.tsx > /tmp/chatview-diff.patch
  git show 7b44dc1 -- src/features/chat/ui/ChatView.tsx > /tmp/chatview-7b44dc1.patch
  ```

- [ ] **Step 2: Apply the surface card wrapper**

  Modify `ChatView.tsx`:
  - Wrap the timeline element in `<div className="rounded-card-chat bg-surface-card pointer-events-none ...">` (outer)
  - Inner `<div className="pointer-events-auto">` for content
  - Composer container: `absolute bottom-0 translate-y-1/2 pointer-events-auto` + glass backdrop via `--backdrop-composer-glass`

- [ ] **Step 3: Padding management + empty state**

  - `pb-12` when `isMcpAppTail()` returns true, `pb-24` otherwise
  - Empty state rendered when `messages.length === 0`. Match branch2's empty-state visual (read the diff).

- [ ] **Step 4: Rename helper to `isMcpAppTail()`**

  Find the existing tail-detection helper (likely `isMcpTail` or similar — search `mcpAppPayload.ts`, `McpAppView.tsx`, `ChatView.tsx`). Rename consistently with single replace-all per file.

- [ ] **Step 5: Validation**

  ```bash
  just check
  just test
  ```

  Expected: green. If `ChatView.test.tsx` exists and snapshots the layout, review the snapshot diff carefully — confirm the change is intentional before re-snapshotting.

- [ ] **Step 6: Visual gate**

  Spec screenshot: **Chat page (composer not properly overlaid).** In dev app:
  - Open a chat with messages → timeline reads as rounded card with surface-card fill, composer floats over the bottom edge
  - Open a fresh chat (no messages) → empty state visible
  - Open an MCP-app-tail chat → `pb-12` reduces bottom padding

- [ ] **Step 7: Commit**

  ```bash
  git add src/features/chat/
  git commit -m "feat(chat): tokenize surface as rounded card + glass-overlap composer + empty state"
  ```

  Do not push.

- [ ] **Step 8: Status report**

  Report: card wrapper applied, composer overlap behavior verified, helper rename complete.

---

### Task 8: PR #8 — Agent gallery card-fill

**Owner:** Claude subagent
**Branch:** `tulsi/reskin-cleanup-8-agents` off `origin/main`
**Branch2 commits referenced:** `9006642` (rebuild list page per Figma 916:17434 + full-width grid), `d524f71` (strip Agents empty-state text — applied in PR #4 already)
**Dependencies:** PR #1 (tokens), PR #4 (PageHeader already removed; TopBar actions wired)
**Load-bearing main work touched:** Avatar catalog assets and helpers (`src/shared/avatars/catalog*.ts`, `avatar-media.tsx`, `useAvatarSrc`). The PR consumes these — confirm in description that the catalog stays intact.

**Files:**
- Modify: `src/features/agents/ui/AgentsView.tsx` (418 LOC)
- Modify: `src/features/agents/ui/PersonaCard.tsx`, `PersonaGallery.tsx`

**Scope summary:** Restore richer persona card rendering — avatars via `useAvatarSrc`, skill-pill palette colors (`--color-pill-*`), card-fill with gradient backgrounds, expanded hover treatment, full-width grid.

- [ ] **Step 1: Branch + diff**

  ```bash
  git switch -c tulsi/reskin-cleanup-8-agents origin/main
  # PR #1 and PR #4 must be merged.
  git diff origin/main..origin/tulsi/ui-reskin-branch2 -- src/features/agents/ui/ > /tmp/agents-diff.patch
  git show 9006642 -- src/features/agents/ui/ > /tmp/agents-9006642.patch
  ```

- [ ] **Step 2: Apply card-fill + gradient backgrounds to `PersonaCard.tsx`**

  Hand-port the card-fill treatment from `9006642`. Use tokens only (no hex/rgba). For gradient backgrounds, use `bg-gradient-to-br from-... to-...` Tailwind utilities with token-backed color stops.

  Pill palette colors: branch2 uses `--color-pill-*` tokens. If those tokens weren't introduced in PR #1, add them now in `globals.css` with both light/dark and `--color-*` bridges — note this as a small PR #1 follow-on amendment to the cleanup train (does not invalidate PR #1 review).

- [ ] **Step 3: Wire `useAvatarSrc` for persona avatars**

  Confirm `useAvatarSrc` exists in `src/shared/avatars/`. Replace any direct avatar-asset path resolution in `PersonaCard.tsx` with the hook.

- [ ] **Step 4: Full-width grid in `PersonaGallery.tsx`**

  Match branch2's grid layout. Likely a Tailwind `grid grid-cols-N gap-N` with responsive breakpoints.

- [ ] **Step 5: Validation**

  ```bash
  just check
  just test
  ```

  Note: `PersonaEditor.test.tsx` is red on branch2; main's must stay green. If a test breaks because of PR #8 changes, fix within scope.

- [ ] **Step 6: Visual gate**

  Spec screenshot: **Agents Page.** Confirm:
  - Cards have gradient fill (no border ring; no drop shadow)
  - Avatars render via the catalog
  - Skill pills carry correct identity tints
  - Grid is full-width
  - Hover treatment expands as in branch2

- [ ] **Step 7: Commit**

  ```bash
  git add src/features/agents/ src/shared/styles/globals.css
  git commit -m "feat(agents): card-fill persona cards with gradient backgrounds, avatar catalog, full-width grid"
  ```

  Do not push.

- [ ] **Step 8: Status report**

  Report: card treatment applied, avatar hook wired, grid layout verified, any token additions noted.

---

### Task 9: PR #9 — Skills grid card-fill + flat tile

**Owner:** Claude subagent
**Branch:** `tulsi/reskin-cleanup-9-skills` off `origin/main`
**Branch2 commits referenced:** `8f48c53` (rebuild list page per Figma 1022:3419 — chromeless flat grid), `d843332` (tile reads as a card via hover blur + fill, matches sibling card height)
**Dependencies:** PR #1, PR #4 (PageHeader already removed)
**Load-bearing main work touched:** Bundled-skill support (`bundled_skills.rs`). Skills data flow is untouched — only the card visual changes.

**Files:**
- Modify: `src/features/skills/ui/SkillsView.tsx` (304 LOC)
- Modify: `src/features/skills/ui/SkillCard.tsx`, `SkillsGrid.tsx`, possibly `SkillIcon.tsx`

**Scope summary:** Replace the heavy black border ring with flat tile + hover blur-fill. Sibling card height matching. Recommendation badges, skill-kind icons, better spacing.

- [ ] **Step 1: Branch + diff**

  ```bash
  git switch -c tulsi/reskin-cleanup-9-skills origin/main
  # PR #1 and PR #4 must be merged.
  git diff origin/main..origin/tulsi/ui-reskin-branch2 -- src/features/skills/ui/ > /tmp/skills-diff.patch
  git show 8f48c53 d843332 -- src/features/skills/ui/ > /tmp/skills-port.patch
  ```

- [ ] **Step 2: Remove the black border ring on `SkillCard.tsx`**

  Find the `border-` / `ring-` utility on the card root. Remove. Replace elevation cue with the hover blur-fill treatment from `d843332`.

- [ ] **Step 3: Hover blur + fill**

  Apply the hover treatment: on hover, the tile gains a backdrop blur + surface fill, so it reads as elevated against the dot-grid canvas. Reference `d843332`:

  ```bash
  git show d843332 -- src/features/skills/ui/SkillCard.tsx
  ```

  No drop shadow. Elevation via blur + fill only.

- [ ] **Step 4: Sibling height matching**

  Confirm the grid container uses `grid-flow-row` with `auto-rows-fr` (or equivalent), so adjacent tiles equalize. Reference `8f48c53`.

- [ ] **Step 5: Recommendation badges + skill-kind icons + spacing**

  - Recommendation badge: small chip rendered when a `recommended` flag is true (or however main models it). Token-tinted.
  - Skill-kind icon: `SkillIcon.tsx` already exists; verify its color comes from `--chip-skill-*` tokens or matches branch2's treatment.
  - Spacing: match `8f48c53`'s grid `gap-*` and card `p-*` values.

- [ ] **Step 6: Validation**

  ```bash
  just check
  just test
  ```

- [ ] **Step 7: Visual gate**

  Spec screenshot: **Skills Page.** Confirm:
  - No black border ring on cards
  - Hover on a tile causes blur + fill (no drop shadow)
  - Adjacent cards in the same row have matching heights
  - Recommendation badges visible where applicable
  - Skill-kind icons readable

- [ ] **Step 8: Commit**

  ```bash
  git add src/features/skills/
  git commit -m "feat(skills): flat-tile cards with hover blur+fill, sibling height match, recommendation + kind badges"
  ```

  Do not push.

- [ ] **Step 9: Status report**

  Report: card treatment applied, hover behavior verified, height matching confirmed, ready for review.

---

## Train coordination

Between PRs:

1. **Tulsi pushes and merges PR N** (after reviewing the local commit).
2. **Executor rebases or re-branches** dependent PRs off the new `origin/main`. If a dependent branch was already created, `git rebase origin/main` and re-verify the validation gate.
3. **Executor proceeds to the next PR** as soon as its dependencies in the DAG are satisfied.

Parallel-safe pairs (start simultaneously if subagent budget allows):
- PR #1 + PR #2 (foundation)
- After PR #4 merges: PR #5, PR #6, PR #7, PR #8, PR #9 all in parallel

The plan does not enforce serialization beyond the DAG above.

---

## Out of scope (tracked as separate Linear issues)

These are deferred per the spec:

- Editor modal final visual styling per Alex's Figma (PR #3 restores function, not visual parity)
- Settings redesign (General, Providers, Extensions, Archive, Updates, Doctor)
- Chat context panel design + implementation
- Homepage pinning v2 (cherry-pick branch2's `53a8948`, `ce49137` — **not clean** anymore; needs reconciliation with Kalvin's PR #120 backend changes per spec risk #5)
- Test debt cleanup for `MessageBubble.test.tsx`, `SessionHistoryView.test.tsx`, `PersonaEditor.test.tsx`, `AppShell.navigation.test.tsx` on branch2

---

## Self-review notes

Performed against the spec at `docs/superpowers/specs/2026-05-20-reskin-regression-cleanup-design.md`:

- **Spec coverage:** All nine PRs in the spec have corresponding tasks above. Excluded surfaces from the spec (Settings, Search content, editor modal styling, chat context panel, pinning v2) are excluded here.
- **Load-bearing main work to preserve:** Each task that touches a relevant surface names the load-bearing item in its header (avatar catalog on PR #8, bundled skills on PR #9, backend layout on PR #6, design system inspector spread across all).
- **No-placeholder check:** All test code in PR #2 Step 4, PR #4 Step 4, PR #5 Step 4 is concrete and runnable. Visual steps explicitly skip TDD (Vitest does not test CSS) and substitute a visual verification gate — this is intentional, not a placeholder.
- **Type consistency:** `useTopBarActions(node: ReactNode)` is consistent across PR #4 Steps 3, 4, 8–11. `isMcpAppTail()` is the canonical name from PR #7 Step 4 onward.
- **Convention coverage:** No-pushes, no-`--no-verify`, no-drop-shadows, tokens-only, `type="button"`, `@/` imports, design-system-generate, Tailwind v4 dynamic-class warning — all surfaced in the Critical conventions block, not repeated per-task.
