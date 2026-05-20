# Reskin Regression Cleanup — Design Spec

**Date:** 2026-05-20
**Owner:** Tulsi
**Parent Linear:** [BOT-469 — Track regressions from UI reskin merge stack](https://linear.app/squareup/issue/BOT-469/track-regressions-from-ui-reskin-merge-stack)
**Status:** Design approved; ready for implementation plan

---

## Goal

Bring `origin/main` to the intended visual design from `tulsi/ui-reskin-branch2`, while preserving the load-bearing architectural work that landed on main during Morgan's UI takeover merge stack. Ship as a small, ordered series of surface-focused PRs that are individually reviewable, bisectable, and revertable.

The bar is: visual design as close to perfect as the screenshots show branch2 to be, without sacrificing any feature Morgan deliberately kept on main.

---

## Background

Between the original UI reskin work and now, two things happened:

1. **Morgan landed the reskin stack as six split PRs onto `origin/main`** (#110, #111, #112, #115, #116, #117, #118). These split PRs were sourced from `origin/ui-reskin`, a *stale* reference branch that predates the polish work on `tulsi/ui-reskin-branch2`.
2. **`tulsi/ui-reskin-branch2` continued evolving** with ~9 polish commits and the homepage pinning v2 work that the split PRs never picked up.

The result on `origin/main` today (`2953902`):
- Functional baselines for the reskin are in (#111 universal search, #112 widget canvas stub, #115 chat surface, #116 agent cards, #117 skills grid, #118 editor overlays)
- But every overlay primitive renders see-through (modals, dropdowns, context menus) — a regression in the popover surface tokens
- Sidebar doesn't fully collapse on close — a compact icon rail persists where branch2 hides the sidebar entirely
- Every list page (Agents, Skills, Automations, Session history) still renders an in-page PageHeader (title + subtitle) and action buttons that should have moved to a chrome-level breadcrumb and top-bar action slot
- Page chrome lacks a `Tulsi's World / <Section>` breadcrumb
- Cards on Skills have a heavy black border ring where branch2 has flat tiles with hover-fill
- Home renders a redundant inline composer in addition to the global bottom composer
- Chat composer is not properly overlaid as a frosted-glass card straddle

Diff size between `origin/main` and `tulsi/ui-reskin-branch2`: **332 files, +16,768 / −7,705**. Wholesale merge is not viable.

Morgan's recommendation in her diff notes (Google Doc) was a single small reconciliation PR. We are diverging from that recommendation in scope only — the user's bar is comprehensive visual recovery, not a minimal subset — but we follow Morgan's *core principle*: start from `origin/main`, never from `ui-reskin-branch2`, and selectively reapply intended design.

---

## Reference model

> **Branch2 is the reference for chrome (TopBar / breadcrumb / action slot), sidebar fully-collapse, tokens (canvas / dot-grid / glass), per-page PageHeader removal, card-fill polish, composer enrichment, chat card+glass treatment, and overlay primitive surfaces.**
>
> **Branch2 is NOT the reference for** Search content (keep main's PR #111), Settings (both pending design), final editor modal styling (pending Alex's Figma), or chat context panel (not designed on either branch).

Implementation pattern for each PR:
- Branch from current `origin/main`.
- Reference branch2 by surface for *intent* — not by wholesale cherry-pick.
- Cherry-pick or hand-port commits as appropriate; verify against current main's structure.

---

## Excluded surfaces

These do not change in this cleanup train:

| Surface | Why excluded |
|---|---|
| Settings (General, Providers, Extensions, Archive, Updates, Doctor) | Both main and branch2 have unfinished design work. Matt's existing settings IA stays as-is. |
| Search content (universal search results, typed result rows, Hi heading) | Main's PR #111 is *better* than branch2's sparse "Search your world" empty state. Keep main's content; only the universal sidebar-collapse regression applies. |
| Editor modal final visual styling | Pending Alex's Figma designs. PR #3 in this train (overlay primitives) restores the missing surface so modals are *usable*, but does not chase visual parity with branch2. Final styling is a separate downstream PR. |
| Chat context panel (right-side Workspace / Changes panel) | "Not designed" on both branches per Tulsi's screenshot review. |
| Homepage pinning v2 | Feature work, not regression cleanup. Ships as a separate downstream PR after this train completes. |

---

## Load-bearing main work to preserve

These must survive every PR in the train. Each PR description must explicitly list which of these it touches (or confirm none).

- **Design system inspector and audit tooling** — `src/features/design-system/`, bottom-right inspect tool, design-system scripts/manifests
- **Backend layout state (PR #109 + #120)** — `src-tauri/src/commands/layout.rs`, migrations `20260519180000_create_layout.sql` and `20260520120000_remove_layout_item_kind_check.sql`, frontend layout API wrappers. Includes Kalvin's PR #120 extensions: the `LayoutItemKind` enum now contains `Session`, `Project`, `Persona`, `Clock`, `Automation`; `SaveLayoutItemsRequest` requires a `replace_kinds` field; `read_layout` skips unknown stored kinds; HomeView hydrates from backend via the layout API (no longer localStorage-backed) and seeds a default clock when the backend layout is empty.
- **Onboarding silent migration** — `useOnboardingGate` and the AppShell migration replacement
- **Avatar catalog assets and helpers** — `src/shared/avatars/catalog*.ts`, webm/hevc files, `avatar-media.tsx`
- **Bundled-skill support** — `src-tauri/src/services/bundled_skills.rs`, distro skill packaging, agent-builder bundling
- **Session bulk-selection infrastructure** — not currently used but kept for future
- **Refactored app-shell helpers** — `useResizableSidebar`, `useProjectDialog`, `settingsSectionUrl`, app navigation helpers (PR #2 re-integrates these where branch2 had inlined them)
- **Search i18n locale files** — `src/shared/i18n/locales/{en,es}/search.json`
- **`useExclusiveMenu` hook**, **BottomFade** component, other small main utilities

---

## PR train

Nine PRs, partitioned into a foundation trio (1–3) that lands first, a Codex track (4–5), and a Claude subagent track (6–9). Foundation lands serially; tracks fan out after.

```
        ┌── #1 Tokens ───┐
origin ─┤                ├── #3 Overlay primitives ──┬── #4 Chrome + PageHeader ──── #5 Sidebar
        └── #2 AppShell ─┘                           │
                                                     ├── #6 Composer pill
                                                     ├── #7 Chat surface
                                                     ├── #8 Agent cards
                                                     └── #9 Skills cards
```

Each PR below specifies:
- **Scope** — what changes
- **Owner** — Codex (structural / data / Rust) or Claude subagent (visual polish / Tailwind / token wiring)
- **Branch2 commits referenced** — the polish commits that capture intent for this surface
- **Files touched (likely)** — for scoping; not exhaustive
- **Dependencies** — which PRs must land first
- **Screenshot reference** — from the visual diff review

### PR #1 — Tokens & globals foundation

**Scope:** Restore branch2's `src/shared/styles/globals.css` semantic token system, lighter canvas (`#f5f5f5`), translucent chrome surfaces (opacity 0.8), dot-grid color, multi-weight Cash Sans font-faces, chip identity colors (`--chip-chat-bg/fg`, `--chip-project-bg/fg`, `--chip-agent-bg/fg`, `--chip-skill-bg/fg`, `--chip-automation-bg/fg`, `--chip-file-bg/fg`), project tint hook (`--project-tint`), backdrop-glass recipe (`--backdrop-composer-glass`), and surface card tokens (`--surface-chrome`, `--surface-card-soft`, `--surface-composer`). Tailwind `@theme inline` bridge naming (`--color-<name>`) preserved.

**Owner:** Claude subagent
**Branch2 commits referenced:** `72c5e93`, `fc05744`, `5072e2b`, `7b44dc1`
**Files touched:** `src/shared/styles/globals.css`, `tailwind.config.*`, any `@theme inline` bridges
**Dependencies:** none — foundation
**Screenshot reference:** background dot-grid + chrome opacity visible on every screenshot

### PR #2 — AppShell helpers restoration

**Scope:** Re-integrate `useResizableSidebar`, `useProjectDialog`, and `settingsSectionUrl` helpers into `AppShell.tsx` and dependent components. Pure refactor; no visual change. Unblocks PR #4's TopBar work (branch2's TopBar depends on these helpers being available to AppShell).

**Owner:** Codex
**Branch2 commits referenced:** `9a25494` (already on main), `036b18a` (parity batch)
**Files touched:** `src/app/AppShell.tsx`, `src/app/ui/AppShellLayout.tsx`, hooks under `src/app/hooks/`
**Dependencies:** none — parallel-safe with PR #1
**Screenshot reference:** n/a — refactor only

### PR #3 — Overlay primitive surface restoration

**Scope:** Restore opaque surface + shadow + border on shared overlay primitives. Every overlay component in main currently renders see-through because the popover surface token regressed. Touches the small set of shadcn-style primitive files:

- `src/shared/ui/dialog.tsx`
- `src/shared/ui/popover.tsx`
- `src/shared/ui/dropdown-menu.tsx`
- `src/shared/ui/context-menu.tsx`
- `src/shared/ui/hover-card.tsx`
- `src/shared/ui/select.tsx`
- `src/shared/ui/menubar.tsx`
- `src/shared/ui/navigation-menu.tsx`
- `src/shared/ui/tooltip.tsx`
- `src/shared/ui/sheet.tsx`
- `src/shared/ui/alert-dialog.tsx`

This single PR restores: editor modals (new agent, new skill, create project), composer model/project pickers, sidebar item context menus, session-card "..." menus, every dropdown in the app, all tooltips.

**Note:** This is a *functional baseline* restoration. It does not chase Alex's Figma for editor modals — that's a separate downstream PR. The goal is "not see-through" + Goose's no-shadows rule satisfied via border / contrast / surface opacity (no drop shadows; elevation via `bg-surface-overlay` and borders per the project memory rule).

**Owner:** Claude subagent
**Branch2 commits referenced:** `eaceacb` (overlay surface system + Sheet-based editors), `613bc0c` (restore page actions and soften cards)
**Files touched:** the eleven primitive files above
**Dependencies:** PR #1 (consumes the restored surface tokens)
**Screenshot reference:** New agent modal, New skill modal, Create project modal, Selector menu on chat composer, Options menu on sidebar, Options menu on session history page

### PR #4 — Chrome system refactor + PageHeader migration

**Scope:** The largest structural PR. Two internal stages, kept as separate commits inside one PR for bisectability:

**Stage A — Chrome infrastructure:**
- TopBar restores 56px height, traffic-light inset handling, breadcrumb area (`Tulsi's World / <Section>`)
- Add top-bar action slot mechanism (portal or context-based) so pages can mount page-level controls into the chrome
- Restore branch2's TopBar action slot from commit `a5ee6fd`

**Stage B — Page migrations:**
- Remove inline `PageHeader` (title + subtitle) from: Agents (`AgentsView`), Skills (`SkillsView`), Automations index (`AutomationsView`), Session history (`SessionHistoryView`)
- Migrate page-level action buttons (Import, +New skill, +New Agent, Refresh, Add automation, Import) into the top-bar action slot
- Remove fake/dead affordances on Agents page (search input, sort, grid view buttons) per screenshot review
- Add giant inline placeholder pattern on Session history ("Search sessions…" as faded large text replacing the title), and verify Search page already has this pattern via PR #111
- Audit field-group treatment on Automation detail right pane (heavy borders → cleaner field groups); fold into this PR if it's a global PageShell concern, otherwise note for follow-up

**Owner:** Codex (Stage A — structural / TopBar / action slot mechanism); Claude subagent (Stage B — per-page migrations once the action slot exists)
**Branch2 commits referenced:** `5072e2b` (chrome surfaces), `a5ee6fd` (topbar action slot + bottom fade + card fill), `d524f71` (strip Agents empty-state text + lighten TopBar page label), `14e5a1d` (editor overlay polish + chrome-panel top-edge alignment)
**Files touched:** `src/app/ui/TopBar.tsx`, `src/app/ui/AppShellLayout.tsx`, `src/shared/ui/page-shell.tsx`, every `*View.tsx` for the affected list pages, possibly a new `useTopBarActions` hook / `<TopBarActionSlot>` component
**Dependencies:** PR #1, PR #2
**Screenshot reference:** Skills Page, Agents Page, Home screen, Create automation, Automation Opened, Automations Page, Session history page

### PR #5 — Sidebar fully-collapse + restoration

**Scope:** Two parts:

**Part A — Fully-collapse on close (regression fix):** When the user closes the sidebar, hide it entirely. Main's current behavior keeps a compact icon rail visible; branch2's behavior is full collapse (only the chrome dots / traffic lights visible). This is universal across every page in screenshots.

**Part B — Restore lost features:** Branch2's Sidebar carries content that main lost in the split PRs. Restore selectively:
- Sidebar items: New chat, Home, Agents, Skills, Automations, Session history, Settings
- Project section grouping + chats list grouping
- (The pinned section *renders empty* in this train — pinning v2 backend is excluded. Reserve space and component shell only; data layer wires in later.)
- Sidebar mask-fade treatment from commit `5d2203e`
- Session item context menu (Rename, Mark unread, Archive) — the popover for this is PR #3, but the trigger / wiring lives here

**Owner:** Codex (collapse behavior, sidebar prop interface, session item menu wiring); Claude subagent (mask-fade, pinned-section visual shell, item styling)
**Branch2 commits referenced:** `d06a85b` (sidebar + top bar reskin per Figma 891:11342), `5d2203e` (sidebar mask-fade + outline-flat pill)
**Files touched:** `src/features/sidebar/ui/Sidebar.tsx`, sidebar sub-components, `useResizableSidebar` (from PR #2)
**Dependencies:** PR #1, PR #2, PR #3 (for the restored context-menu surface)
**Screenshot reference:** sidebar collapse regression visible on every page

### PR #6 — Composer pill enrichment

**Scope:** Enrich `GlobalComposerPill` with branch2's full treatment: context chip rendering (file/chat/project/agent/skill chips with `--chip-*` tokens), model grouping by provider in the selector, keyboard shortcuts (`Cmd+;` for voice), and the glass-surface backdrop. Investigate the **redundant composer on Home** against Kalvin's refactored HomeView (post-PR #120). His PR explicitly "keeps the composer visible" while introducing backend-hydrated widget state; the previous "inline composer + global composer = two composers" regression may already be resolved. Verify against the current HomeView during scoping; fix only if still present.

**Owner:** Claude subagent (chip rendering, model UX); Codex if the Home redundant-composer investigation reveals a structural issue
**Branch2 commits referenced:** `6c99bfe` (port universal search + global composer from visual-design — note: most of this is already on main via PR #111; we port the *delta*)
**Files touched:** `src/shared/ui/GlobalComposerPill.tsx`, `src/features/home/ui/HomeView.tsx`
**Dependencies:** PR #1 (chip tokens), PR #3 (selector menu surfaces)
**Screenshot reference:** Selector menu on chat composer, Home screen (redundant composer)

### PR #7 — Chat surface card + glass

**Scope:** Wrap chat message timeline in `rounded-card-chat bg-surface-card`. Make composer absolutely positioned, `translate-y-1/2` overlap with backdrop glass filter (`--backdrop-composer-glass`). Outer wrapper `pointer-events-none` so card is scrollable; inner glass wrapper re-enables pointer events. Empty state when `messages.length === 0`. Padding management: `pb-12` for McpApp tail, `pb-24` otherwise. Rename internal tail-detection helper to `isMcpAppTail()` (clarity only).

**Owner:** Claude subagent
**Branch2 commits referenced:** `7b44dc1` (tokenize chat surface against reskin tokens)
**Files touched:** `src/features/chat/ui/ChatView.tsx` (and any chat container components)
**Dependencies:** PR #1
**Screenshot reference:** Chat page (composer not properly overlaid)

### PR #8 — Agent gallery card-fill

**Scope:** Restore richer persona card rendering: avatars via `useAvatarSrc` hook (main has the asset catalog), skill pill palette colors (`--color-pill-*`), card-fill with gradient backgrounds, expanded hover treatment. Branch2's commits cleanly remove the empty-state subtitle ("Custom agent configurations...") — already covered by PR #4's PageHeader removal.

**Owner:** Claude subagent
**Branch2 commits referenced:** `9006642` (rebuild list page per Figma 916:17434 + full-width grid), `d524f71` (strip Agents empty-state text)
**Files touched:** `src/features/agents/ui/AgentsView.tsx`, persona card components, hover/fill styles
**Dependencies:** PR #1, PR #4 (PageHeader removed)
**Screenshot reference:** Agents Page

### PR #9 — Skills grid card-fill + flat tile

**Scope:** Replace skill card black border ring with branch2's flat tile look: card-fill on hover via blur + fill, sibling card height matching. Recommendation badges, skill-kind icons, better spacing.

**Owner:** Claude subagent
**Branch2 commits referenced:** `8f48c53` (rebuild list page per Figma 1022:3419 — chromeless flat grid), `d843332` (tile reads as a card via hover blur + fill, matches sibling card height)
**Files touched:** `src/features/skills/ui/SkillsView.tsx`, skill card components
**Dependencies:** PR #1, PR #4 (PageHeader removed)
**Screenshot reference:** Skills Page

---

## Workflow conventions

For every PR in the train:

1. **Branch from current `origin/main`.** Never from `tulsi/ui-reskin-branch2`. If a branch2 commit is referenced, hand-port the relevant hunks; do not cherry-pick onto an unrelated base.
2. **PR description follows Morgan's behavior-check template:**
   - **Preserved behaviors** — what existing workflows / contracts this PR keeps intact
   - **Intentionally changed behaviors** — what design / IA / UX changes this PR makes
   - **Load-bearing main work touched** — referenced from the list above, with confirmation of preservation
   - **Surfaces touched** — list of files / components
   - **Screenshot diff** — before / after for each surface
3. **Validation gate before pushing:**
   - `just check` — frontend formatting, lint, i18n, types
   - `just test` — Vitest suite
   - `just tauri-check` — Rust check (if `src-tauri/` touched)
   - `just clippy` — Rust clippy (if `src-tauri/` touched)
4. **No `--no-verify`** on commits. Pre-commit hooks are load-bearing. (`LEFTHOOK=0` was used once in a prior session because of unrelated test debt; do not normalize it.)
5. **No drop shadows.** Elevation via `bg-surface-overlay` / borders / contrast. PR #3 in particular must satisfy this rule when restoring opaque overlay surfaces.
6. **No hex / rgba in TS.** Tokens only. JS color refs use `var(--token-name)` strings.
7. **All `<button>` need `type="button"`** unless intentionally submitting.
8. **`@/` imports.** `cn()` from `@/shared/lib/cn` for class merging.
9. **Tailwind v4 dynamic class names** — template literals like `` `bg-chip-${kind}-bg` `` are invisible to the scanner. Use a static lookup map.
10. **`--color-{name}` bridge naming** in `@theme inline` is what makes Tailwind utilities resolve. Don't break this when editing tokens in PR #1.
11. **Do not push without explicit approval** per AGENTS.md.

---

## Risks and open questions

1. **PR #4 is the largest** — chrome refactor + ~5 page migrations. Expected to be 200–400 LOC. If review surface becomes too large, split into 4a (infra) and 4b (page migrations) as two PRs sharing the same conceptual change.
2. **Home redundant-composer bug (PR #6)** — root cause not yet confirmed. May be `HomeView` rendering its own composer; may be AppShell rendering the global composer in a state where HomeView also has one. Investigation is part of PR #6 scope.
3. **Field-group polish on Automation detail right pane (PR #4)** — if this turns out to be a global PageShell concern (used on multiple detail views), it might belong in PR #1 (tokens) rather than PR #4. Decide during scoping.
4. **Editor modal styling per Alex's Figma** — explicitly deferred. After PR #3 restores functional surface, a follow-up PR (separate from this train) brings them to Figma parity. Track in Linear.
5. **Pinning v2** — explicitly deferred. After the cleanup train completes, ship pinning v2 as the next PR. **Not a clean cherry-pick** of branch2's `53a8948` and `ce49137` anymore: Kalvin's PR #120 changed the backend layout API (added `replace_kinds` to `SaveLayoutItemsRequest`, extended `LayoutItemKind` with `Clock` + `Automation`, replaced localStorage-backed home widget persistence with backend hydration). Branch2's pinning commits assume the old API and will need a reconciliation port — updating `usePinMutations.ts`, `homeLayoutMapping.ts`, and any callers of the save endpoint to pass `replace_kinds`. The backend foundation is now stronger; the porting effort is moderate, not trivial.
6. **Test debt on `tulsi/ui-reskin-branch2`** — `AppShell.navigation.test.tsx`, `MessageBubble.test.tsx`, `SessionHistoryView.test.tsx`, `PersonaEditor.test.tsx` are red on branch2 from upstream churn. These do not block this cleanup train because every PR branches off `origin/main`, not branch2. They become relevant only if branch2 is used as a source for cherry-picks — in which case the PR's `just test` gate will surface anything broken.

---

## Out of scope follow-ups

Track as separate Linear issues under BOT-469 or as standalone tickets:

- Editor modal final visual styling per Alex's Figma
- Settings redesign (General, Providers, Extensions, Archive, Updates, Doctor)
- Chat context panel design + implementation
- Homepage pinning v2 (cherry-pick branch2's pinning commits onto clean main)
- Test debt cleanup for `MessageBubble.test.tsx`, `SessionHistoryView.test.tsx`, `PersonaEditor.test.tsx`, `AppShell.navigation.test.tsx`

---

## Approval

Design approved 2026-05-20 by Tulsi during brainstorming session. Next step: write the implementation plan via the writing-plans skill.
