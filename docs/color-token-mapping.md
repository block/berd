# Color Token Mapping

Date: 2026-05-21

## The New Rule

Use Tailwind utilities backed by the shadcn token contract first. Use Goose tokens only when the color is product-specific and does not exist in shadcn's shared vocabulary.

In practice:

1. Shared UI should use shadcn names: `background`, `foreground`, `card`, `popover`, `muted`, `accent`, `primary`, `destructive`, `border`, `input`, and `ring`.
2. Sidebar UI should use shadcn sidebar names: `sidebar`, `sidebar-foreground`, `sidebar-accent`, `sidebar-border`, and `sidebar-ring`.
3. Goose-specific surfaces keep Goose names only when shadcn has no matching role: `canvas-*`, `surface-composer`, composer chips, status colors, project tint, and dot-grid variables.

This follows the shadcn theming model: core tokens describe component anatomy and state, while Tailwind classes are the authoring API.

## Core Tokens To Use

| Need | Use | Tailwind examples | Mental model |
| --- | --- | --- | --- |
| App/page background | `background` + `foreground` | `bg-background text-foreground` | The ordinary app canvas or page body. |
| Contained surface | `card` + `card-foreground` | `bg-card text-card-foreground` | Cards and stable panels. |
| Floating overlay | `popover` + `popover-foreground` | `bg-popover text-popover-foreground` | Menus, popovers, dropdowns, inspectors. |
| Quiet fill or secondary zone | `muted` + `muted-foreground` | `bg-muted text-muted-foreground` | Low-emphasis blocks and secondary text. |
| Hover, active, selected, highlighted | `accent` + `accent-foreground` | `hover:bg-accent hover:text-accent-foreground` | The standard gray interaction fill. |
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

## Goose Extensions We Keep

| Token family | Why it exists | Tailwind examples |
| --- | --- | --- |
| `canvas-base`, `canvas-project-tint` | Goose's dot-grid app canvas and project tinting are product-specific. | `bg-canvas-base` |
| `sidebar` | Frosted app chrome/sidebar/context-panel shell treatment. | `bg-sidebar` |
| `surface-composer`, `surface-composer-glass` | Composer-specific translucent surfaces. | `bg-surface-composer` |
| `surface-editor-panel` | Large slide-out editor panels use a translucent glass surface over the canvas. | `bg-surface-editor-panel` |
| `surface-agent-profile-*` | Agent profile and avatar-editing surfaces are intentionally theme-invariant and use values that do not perfectly match shared shadcn tokens. | `bg-surface-agent-profile-bg text-surface-agent-profile-fg` |
| `message-user-bg` | User message bubble fill is a chat-specific surface that should not become a broad card or muted token. | `bg-message-user-bg` |
| `text-placeholder-composer` | Composer placeholder needs a denser value than normal muted text. | `placeholder:text-placeholder-composer` |
| `chip-*-bg`, `chip-*-fg` | File/chat/project/agent/skill/automation identity chips. | `bg-chip-agent-bg text-chip-agent-fg` |
| `skill-pill-fg` | Skill name labels on theme-invariant pastel skill/project pill tones. | `text-skill-pill-fg` |
| `success`, `warning`, `info` | Non-destructive status colors, modeled after shadcn's destructive pattern. | `text-success bg-success/10` |
| `popover-inverse` | Dark popover on light UI for specific inverse menus. | `bg-popover-inverse text-popover-inverse-foreground` |
| `clock-face`, `clock-mark`, `clock-hand`, `dark-*`, `dot-*`, `status-*`, `chart-*` | Product visuals, charts, activity states, and canvas details. `clock-face` and `clock-mark` flip between themes; `clock-hand` stays red in both. | `bg-clock-face`, `bg-clock-mark`, `bg-clock-hand`, `text-status-added` |

## Deleted Or Replaced Names

| Old token/class family | Replacement | Why |
| --- | --- | --- |
| `background-default`, `text-default` | `background`, `foreground` | Same job as shadcn's app surface pair. |
| `background-alt`, `background-hover`, `text-hover` | `accent`, `accent-foreground` | shadcn uses accent for hover, active, and highlighted low-emphasis states. |
| `background-muted`, `text-muted` | `muted`, `muted-foreground` | Same job as shadcn's muted pair. |
| `background-primary`, `text-on-primary` | `primary`, `primary-foreground` | Same job as shadcn primary. |
| `background-danger-strong`, `text-on-danger-strong` | `destructive`, `destructive-foreground` | Same job as shadcn destructive. |
| `background-danger`, `text-danger` | `destructive/10`, `destructive` | Destructive tint plus destructive text. |
| `background-success`, `text-success` old pair | `success/10`, `success` | Keep status as a small Goose extension, not broad background tokens. |
| `background-warning`, `text-warning` old pair | `warning/10`, `warning` | Same status-extension pattern. |
| `background-info`, `text-info` old pair | `info/10`, `info` | Same status-extension pattern. |
| `surface-card` | `card` | Card is a shadcn core token. |
| `surface-user-bubble` | `message-user-bg` | User bubble fill is message-specific, so it gets a narrow Goose token instead of reviving `surface-*`. |
| `surface-overlay`, `background-popover`, `text-on-popover` | `popover`, `popover-foreground` | Floating surfaces should use shadcn popover. |
| `border-default`, `border-soft`, `border-strong` | `border`, usually with opacity like `border-border/80` | One structural border token is enough for now. |
| `border-input` old alias | `input` | shadcn input token. |
| `border-focus`, `ring-focus` | `ring` | shadcn focus token. |
| `sidebar-nav-bg-hover`, `sidebar-nav-bg-selected`, `sidebar-nav-fg` | `sidebar-accent`, `sidebar-accent-foreground`, `sidebar-foreground` | shadcn already has sidebar state tokens. |

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
| Is this a Goose-only product surface or identity chip? | Use the smallest Goose extension token that names that product job. |
