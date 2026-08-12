---
name: design-system-tokens
description: Ensure UI color changes use the Berd shadcn-first token contract instead of raw palette values or broad custom tokens.
severity-default: medium
tools: [Grep, Read]
---

Review changed frontend styling for design-system token drift.

Use `docs/color-token-mapping.md` as the source of truth for how colors should
be chosen. The short version:

- Shared UI should use shadcn semantic tokens first: `background`,
  `foreground`, `card`, `popover`, `muted`, `accent`, `primary`,
  `secondary`, `destructive`, `border`, `input`, and `ring`.
- Sidebar rows and text should use the shadcn sidebar state tokens:
  `sidebar-foreground`, `sidebar-accent`, `sidebar-border`, and
  `sidebar-ring`. Floating chrome shells (nav panes, right rail, top bar)
  paint `card-glass`; the bare `sidebar` shell token is retired.
- Berd-specific tokens are allowed only for product-specific surfaces that do
  not map cleanly to shadcn, such as `canvas-*`, `surface-composer`,
  `surface-editor-panel`, `message-user-bg`, `chip-*-bg`, `chip-*-fg`,
  `success`, `warning`, `info`, and clock/status/chart tokens.

## What to flag

- **Raw Tailwind palette utilities** like `text-gray-*`, `bg-zinc-*`,
  `border-neutral-*`, `ring-blue-*`, `fill-slate-*`, or `stroke-stone-*`.
  Suggest the closest semantic token instead, such as `text-muted-foreground`,
  `bg-accent`, `border-border`, `border-input`, or `ring-ring`.
- **Deleted broad Berd token families** such as `background-default`,
  `background-hover`, `text-default`, `text-muted`, `border-default`,
  `border-focus`, `surface-card`, `surface-overlay`, `surface-chrome`,
  `sidebar-nav-bg-hover`, or `sidebar-nav-fg` — and the retired shell tokens
  `bg-sidebar`/`--sidebar`, `sidebar-navigation-panel-bg`,
  `canvas-project-tint`, and `surface-agent-profile-bg`. Suggest the mapping
  in `docs/color-token-mapping.md`.
- **New broad custom color tokens** that duplicate shadcn concepts. For
  example, do not introduce a new token that means "normal page background",
  "hover gray", "secondary text", "card surface", "popover surface",
  "default border", "input border", or "focus ring"; use shadcn tokens.
- **Berd extension tokens without a narrow product job.** If a new token is
  added, it should name a real Berd-specific surface or identity role, and the
  PR should update both `docs/color-token-mapping.md` and
  `scripts/design-system-tokens.mjs`.
- **Component-level one-off color decisions** where the same role already
  exists in a shared UI primitive. Prefer adjusting the shared primitive or
  design token over scattering local styling.

## What not to flag

- Approved shadcn token utilities such as `bg-background`, `text-foreground`,
  `bg-card`, `bg-popover`, `bg-muted`, `bg-accent`, `bg-primary`,
  `bg-secondary`, `bg-destructive`, `border-border`, `border-input`, or
  `ring-ring`.
- Approved sidebar state utilities such as `text-sidebar-foreground`,
  `hover:bg-sidebar-accent`, `border-sidebar-border`, and
  `ring-sidebar-ring`. The pane shell itself is `bg-card-glass`, not
  `bg-sidebar`.
- Approved narrow Berd extension utilities documented in
  `docs/color-token-mapping.md`, such as `bg-canvas-base`,
  `bg-surface-composer`, `bg-message-user-bg`, chip tokens, status tokens, and
  clock/chart tokens.
- Opacity modifiers on semantic tokens when they preserve the role, such as
  `border-border/70`, `bg-destructive/10`, or `text-muted-foreground/70`.

## Review posture

Only leave comments that are actionable. Name the specific semantic token or
shared primitive the author should use. If the automated
`design-system:tokens` check already catches the issue, mention that command as
the quick local verification path rather than restating the entire token system.
