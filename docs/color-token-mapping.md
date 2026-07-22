# Color Token Mapping

Date: 2026-05-21

## The New Rule

Use Tailwind utilities backed by the shadcn token contract first. Use Berd tokens only when the color is product-specific and does not exist in shadcn's shared vocabulary.

In practice:

1. Shared UI should use shadcn names: `background`, `foreground`, `card`, `popover`, `muted`, `accent`, `primary`, `destructive`, `border`, `input`, and `ring`.
2. Sidebar UI should use shadcn sidebar names: `sidebar`, `sidebar-foreground`, `sidebar-accent`, `sidebar-border`, and `sidebar-ring`.
3. Berd-specific surfaces keep product-specific names only when shadcn has no matching role: `canvas-*`, `surface-composer`, composer chips, status colors, project tint, and dot-grid variables.

This follows the shadcn theming model: core tokens describe component anatomy and state, while Tailwind classes are the authoring API.

## Core Tokens To Use

| Need | Use | Tailwind examples | Mental model |
| --- | --- | --- | --- |
| App/page background | `background` + `foreground` | `bg-background text-foreground` | The ordinary app canvas or page body. |
| Contained surface | `card` + `card-foreground` | `bg-card text-card-foreground` | Cards and stable panels. |
| Floating overlay | `popover` + `popover-foreground` | `bg-popover text-popover-foreground` | Menus, popovers, dropdowns, inspectors. |
| Quiet fill or secondary zone | `muted` + `muted-foreground` | `bg-muted text-muted-foreground` | Low-emphasis blocks and secondary text. |
| Hover, active, selected, highlighted | `accent` + `accent-foreground` | `hover:bg-accent hover:text-accent-foreground` | The standard gray interaction fill. |
| Hover step for accent-filled controls | `accent-hover` | `bg-accent hover:bg-accent-hover` | One visible step past `accent` in both themes (gray-50→gray-100 light, gray-700→gray-600 dark). For controls that already rest on `accent`, like the subtle button. |
| Primary action | `primary` + `primary-foreground` | `bg-primary text-primary-foreground` | Main action buttons and strong selected states. |
| Destructive action | `destructive` + `destructive-foreground` | `bg-destructive text-destructive-foreground` | Delete/remove/danger actions. |
| Default border | `border` | `border-border` | Structure and dividers. |
| Form/control border | `input` | `border-input` | Input, select, and button-outline borders. |
| Focus ring | `ring` | `ring-ring focus-visible:ring-ring` | Keyboard focus and active focus outlines. |

## Sidebar Tokens

| Need | Use | Tailwind examples |
| --- | --- | --- |
| Sidebar shell | `sidebar` | `bg-sidebar text-sidebar-foreground` |
| Sidebar hover or selected row | `sidebar-accent` | `hover:bg-sidebar-accent` |
| Sidebar selected/hover text | `sidebar-accent-foreground` | `text-sidebar-accent-foreground` |
| Sidebar divider | `sidebar-border` | `border-sidebar-border` |
| Sidebar focus ring | `sidebar-ring` | `ring-sidebar-ring` |

The current sidebar value is intentionally slightly off-white/translucent, not pure white.

## Berd Extensions We Keep

| Token family | Why it exists | Tailwind examples |
| --- | --- | --- |
| `canvas-base`, `canvas-project-tint` | Berd's dot-grid app canvas and project tinting are product-specific. | `bg-canvas-base` |
| `sidebar` | Frosted app chrome/sidebar/context-panel shell treatment. | `bg-sidebar` |
| `surface-composer`, `surface-composer-glass`, `surface-composer-hover` | Composer-specific translucent surfaces and their hover counterpart. | `bg-surface-composer` |
| `surface-chat-composer`, `surface-chat-composer-hover` | Floating chat composer shell over the transcript; muted translucent gray. | `bg-surface-chat-composer` |
| `surface-composer-action`, `surface-composer-action-hover`, `surface-composer-action-active` | Chat composer toolbar control fills (agent/model pickers, branch selector). | `bg-surface-composer-action`, `hover:bg-surface-composer-action-hover` |
| `surface-chat-responding-pill-bg`, `surface-chat-responding-pill-fg` | “Responding” status pill beside the composer; inverts with theme. | `bg-surface-chat-responding-pill-bg text-surface-chat-responding-pill-fg` |
| `chat-context-panel-*` | Scoped palette for the glass chat context panel aside (background, foreground, accent). Applied via `.chat-context-panel-surface`. | `bg-background text-foreground` (scoped) |
| `surface-glass-subtle` | Quiet translucent glass surface for temporary overlays where the content behind should stay readable. Pair with `--backdrop-glass-subtle` when a blur filter is needed. | `bg-surface-glass-subtle` |
| `surface-glass-strong`, `surface-glass-strong-hover`, `surface-glass-strong-fg` | Stronger glass controls that sit over artwork or other visually busy media where ordinary foreground-on-glass can lose contrast. | `bg-surface-glass-strong text-surface-glass-strong-fg` |
| `surface-agent-tile-action-*` | Agent tile View/Chat/⋯ controls: glass white + charcoal text in light theme, inverted surface in dark theme; hover/active/open invert foreground/background in both themes. | `bg-surface-agent-tile-action-bg text-surface-agent-tile-action-fg`, `hover:bg-surface-agent-tile-action-bg-hover` |
| `surface-editor-panel` | Large slide-out editor panels use a translucent glass surface over the canvas. | `bg-surface-editor-panel` |
| `surface-agent-profile-*` | Agent profile and avatar-editing surfaces are product-specific and theme-aware; their light and dark values do not perfectly match shared shadcn tokens. | `bg-surface-agent-profile-bg text-surface-agent-profile-fg` |
| `message-user-bg` | User message bubble fill is a chat-specific surface that should not become a broad card or muted token. | `bg-message-user-bg` |
| `text-placeholder-composer` | Composer placeholder needs a denser value than normal muted text. | `placeholder:text-placeholder-composer` |
| `chip-*-bg`, `chip-*-fg` | File/chat/project/agent/skill/automation identity chips. | `bg-chip-agent-bg text-chip-agent-fg` |
| `skill-pill-fg` | Skill name labels on theme-invariant pastel skill/project pill tones. | `text-skill-pill-fg` |
| `success`, `warning`, `info` | Non-destructive status colors, modeled after shadcn's destructive pattern. | `text-success bg-success/10` |
| `popover-inverse` | Dark popover on light UI for specific inverse menus, with `popover-inverse-focus` for highlighted menu rows. | `bg-popover-inverse text-popover-inverse-foreground focus:bg-popover-inverse-focus` |
| `clock-face`, `clock-mark`, `clock-minute-hand`, `clock-hand`, `sticky-note-*`, `dark-*`, `dot-*`, `status-*`, `chart-*` | Product visuals, charts, activity states, onboarding sticky notes, and canvas details. `clock-face` and `clock-mark` flip between themes; `clock-minute-hand` is light gray on the dark face and mid-gray on the light face; `clock-hand` (second hand) stays red in both. Sticky note tokens include note surfaces and muted text. | `bg-clock-face`, `bg-clock-mark`, `bg-clock-minute-hand`, `bg-clock-hand`, `bg-sticky-note-warm`, `text-status-added` |
| `app-top-bar-control-fg`, `app-top-bar-control-fg-disabled`, `app-top-bar-control-hover-opacity` | Deep charcoal top bar controls beside the breadcrumb trail; disabled back/forward use 35% opacity of the control foreground; clickable controls fade to 70% opacity on hover. Light theme pins `#242424`; dark theme follows `foreground`. | `text-app-top-bar-control-fg`, `text-app-top-bar-control-fg-disabled`, `hover:opacity-[var(--app-top-bar-control-hover-opacity)]` |
| `sidebar-section-action-*` | Scoped action-pill colors for Projects / Chats section header controls. The token layer owns default and hover contrast for light and dark themes. | `bg-sidebar-section-action-bg`, `hover:bg-sidebar-section-action-bg-hover`, `text-sidebar-section-action-fg-hover` |

## Deleted Or Replaced Names

| Old token/class family | Replacement | Why |
| --- | --- | --- |
| `background-default`, `text-default` | `background`, `foreground` | Same job as shadcn's app surface pair. |
| `background-alt`, `background-hover`, `text-hover` | `accent`, `accent-foreground` | shadcn uses accent for hover, active, and highlighted low-emphasis states. |
| `background-muted`, `text-muted` | `muted`, `muted-foreground` | Same job as shadcn's muted pair. |
| `background-primary`, `text-on-primary` | `primary`, `primary-foreground` | Same job as shadcn primary. |
| `background-danger-strong`, `text-on-danger-strong` | `destructive`, `destructive-foreground` | Same job as shadcn destructive. |
| `background-danger`, `text-danger` | `destructive/10`, `destructive` | Destructive tint plus destructive text. |
| `background-success`, `text-success` old pair | `success/10`, `success` | Keep status as a small Berd extension, not broad background tokens. |
| `background-warning`, `text-warning` old pair | `warning/10`, `warning` | Same status-extension pattern. |
| `background-info`, `text-info` old pair | `info/10`, `info` | Same status-extension pattern. |
| `surface-card` | `card` | Card is a shadcn core token. |
| `surface-user-bubble` | `message-user-bg` | User bubble fill is message-specific, so it gets a narrow Berd token instead of reviving `surface-*`. |
| `surface-overlay`, `background-popover`, `text-on-popover` | `popover`, `popover-foreground` | Floating surfaces should use shadcn popover. |
| `border-default`, `border-soft`, `border-strong` | `border`, usually with opacity like `border-border/80` | One structural border token is enough for now. |
| `border-input` old alias | `input` | shadcn input token. |
| `border-focus`, `ring-focus` | `ring` | shadcn focus token. |
| `sidebar-nav-bg-hover`, `sidebar-nav-bg-selected`, `sidebar-nav-fg` | `sidebar-accent`, `sidebar-accent-foreground`, `sidebar-foreground` | shadcn already has sidebar state tokens. |
| `sidebar-nav-font-weight-light` | `--sidebar-nav-font-weight` (400), `font-normal`, `SIDEBAR_NAV_TEXT_CLASS` | Sidebar navigation labels use regular weight, not light. |

## Button State Mapping

| Button intent | Default | Hover | Disabled |
| --- | --- | --- | --- |
| `default` | `bg-primary text-primary-foreground` | `bg-primary/90` | shadcn disabled behavior. |
| `secondary` | `bg-secondary text-secondary-foreground` | `bg-secondary/80` | shadcn disabled behavior. |
| `outline` | `border-input bg-background text-foreground` | `bg-accent text-accent-foreground` | shadcn disabled behavior. |
| `ghost` | `bg-transparent text-foreground` | `bg-accent text-accent-foreground` | shadcn disabled behavior. |
| `quiet` | `bg-transparent text-muted-foreground` | `bg-transparent text-foreground` | shadcn disabled behavior. |
| `destructive` | `bg-destructive text-destructive-foreground` | `bg-destructive/90` | shadcn disabled behavior. |

Use `quiet` for icon-only chrome buttons that should be gray by default and black on hover without a hover fill. Use `ghost` when the hover should show the shared gray fill.

## Tokens Consumed In Raw CSS

Most color tokens are consumed through Tailwind utility classes (`bg-accent`,
`text-foreground`). Those tokens need an `@theme inline` bridge entry
(`--color-x: var(--x)`) so Tailwind can generate the utility.

Some surfaces cannot be styled with a utility class on an element: pseudo-element
selectors (`::selection`, `::-webkit-scrollbar-thumb`), the CSS Custom Highlight
API (`::highlight(...)`), and non-color CSS properties (filters, opacities).
These are styled directly in `globals.css` and read their token with `var(...)`.

The rule:

- Bridge a token into `@theme inline` **only when a component authors the color
  through a `bg-*` / `text-*` / `border-*` class.** Bridging a token that no
  utility class can ever use creates dead surface, so do not do it.
- Otherwise, define the token in `:root` + the dark block (with both light and
  dark values) and consume it with `var(--token)` in the same `globals.css`
  rule. These are still first-class semantic tokens; they simply skip the
  Tailwind bridge.
- Name these tokens for their product meaning and anatomy, not the CSS hook they
  happen to use.

These raw-`var()` **color** tokens are validated by `pnpm design-system:tokens`.
The check reads every color token in `:root`/`.dark` and requires each one to be
either bridged into `@theme inline` or present in the raw-CSS color allowlist in
`scripts/design-system-tokens.mjs`. That allowlist is kept identical to the
machine-readable list below (the check fails if they drift), so a new raw-`var()`
color token must be added in both places. Duplicate declarations in either
`:root` or `.dark`, dark-only color tokens, and light/dark pairs whose values do
not both resolve to colors also fail the check. Keep semantic declarations in
the top-level theme blocks rather than nesting `:root` or `.dark` overrides in
media queries; the contract intentionally requires one unconditional source of
truth. Theme-invariant pairing exemptions must be removed if a token later gains
a `.dark` override. Non-color raw-CSS tokens (opacity, filter values) are not
part of the color contract; they are listed in the table for reference only.

The authoritative list of raw-CSS color tokens (kept in sync with the script):

<!-- raw-css-color-tokens:start -->
```
# ::selection
--text-selection-bg
--text-selection-fg
# ::-webkit-scrollbar-thumb
--scrollbar-thumb
--scrollbar-thumb-hover
# Sidebar row states (bg-[var(...)])
--sidebar-row-hover
--sidebar-row-active
# Prototype nav text (text-[var(...)])
--sidebar-prototype-nav-muted-fg
--sidebar-prototype-nav-default-fg
--sidebar-prototype-nav-active-fg
# ::highlight(chat-search-match[-active])
--chat-search-match-bg
--chat-search-match-fg
--chat-search-match-active-bg
--chat-search-match-active-fg
# .chat-context-panel-surface scoped block
--chat-context-panel-bg
--chat-context-panel-fg
--chat-context-panel-muted-fg
--chat-context-panel-border
--chat-context-panel-accent
--chat-context-panel-accent-fg
--chat-context-panel-hover
# .chat-context-dropdown scoped block
--chat-context-dropdown-bg
--chat-context-dropdown-hover
--chat-context-dropdown-fg
--chat-context-dropdown-muted-fg
# Editor field surfaces (color-mix bases + arbitrary-value utilities)
--surface-editor-panel-neutral
--surface-editor-control
--surface-editor-control-hover
--surface-editor-badge
--surface-color-picker-swatches
--text-editor-field-placeholder
--border-editor-divider
# Glass/overlay surfaces (inline styles + arbitrary values)
--surface-popover-glass
--overlay-scrim
--overlay-global-composer-shim
--overlay-global-composer-shim-peak
--overlay-global-composer-shim-clear
--ring-composer-glass-inner
--outline-composer-glass-outer
# SVG stroke consumed via an inline constant
--project-glyph-fold-stroke
# Runtime project-tint hook (transparent default)
--project-tint
# Dot-grid canvas color (raw-CSS gradient)
--dot-color-base
```
<!-- raw-css-color-tokens:end -->

The table below is a human-readable overview of the raw-`var()` pattern. It
groups tokens by surface and may use globs; the marker-wrapped list above is the
exact machine-checked contract.

| Token | Where it is applied | Why it is not bridged |
| --- | --- | --- |
| `text-selection-bg`, `text-selection-fg` | `::selection` | Pseudo-element; a `bg-*` class cannot target selected text. Lighter primary tint with normal foreground text so selection reads as a quiet highlight, not an inverted fill. |
| `chat-search-match-bg`, `chat-search-match-fg`, `chat-search-match-active-bg`, `chat-search-match-active-fg` | `::highlight(chat-search-match[-active])` | CSS Custom Highlight API ranges; not element-class styleable. |
| `scrollbar-thumb`, `scrollbar-thumb-hover` | `::-webkit-scrollbar-thumb` | Scrollbar pseudo-element. |
| `filter-chat-responding-goose` | `filter` property | Non-color CSS property, not a color utility. |
| `app-top-bar-control-hover-opacity` | `opacity` via `hover:opacity-[var(...)]` | Opacity value, consumed through an arbitrary-value utility. |
| `chat-context-panel-*` | `.chat-context-panel-surface` scoped block | Scoped palette applied through a class, not per-element color utilities. |
| `overlay-global-composer-shim`, `overlay-global-composer-shim-peak`, `overlay-global-composer-shim-clear` | `.global-composer-shim` and `@keyframes global-composer-shim-*` | Main-canvas glass shim and white midpoint cross-fade are authored in raw CSS during the global composer handoff, not through per-element color utilities. |

## Decision Tree

| Question | Token choice |
| --- | --- |
| Is this normal app text or page background? | `foreground` / `background` |
| Is this a card or stable panel? | `card` / `card-foreground` |
| Is this floating above the page? | `popover` / `popover-foreground` |
| Is this a hover, active, selected, or highlighted row? | `accent` / `accent-foreground` |
| Is this secondary text? | `muted-foreground` |
| Is this a sidebar row state? | `sidebar-accent` / `sidebar-accent-foreground` |
| Is this a focus outline? | `ring` |
| Is this a form/control border? | `input` |
| Is this a Berd-only product surface or identity chip? | Use the smallest Berd extension token that names that product job. |
| Is this a pseudo-element, highlight, filter, or opacity that no utility class can target? | Define a `:root`/dark token and consume it with `var(...)`. See [Tokens Consumed In Raw CSS](#tokens-consumed-in-raw-css). |
