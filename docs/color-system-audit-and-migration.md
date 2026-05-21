# Color System Audit And Migration

Date: 2026-05-21

## Summary

Goose now uses a simpler color contract:

1. Tailwind 4 is the utility engine.
2. shadcn tokens are the default semantic language for shared UI.
3. Goose extension tokens are kept only for product-specific surfaces and identity colors.

The migration intentionally keeps the existing Goose palette instead of resetting the visual system to generic Tailwind grays. The nice off-white sidebar/chrome values, light gray hover fills, black/white contrast, composer glass, dot-grid canvas, and chip colors are preserved.

For the simple mapping table, use [color-token-mapping.md](./color-token-mapping.md).

## What Was Wrong Before

The previous system had three overlapping naming systems:

| Layer | Examples | Problem |
| --- | --- | --- |
| shadcn tokens | `background`, `foreground`, `card`, `popover`, `accent` | Present, but not consistently used. |
| Goose broad aliases | `background-default`, `background-hover`, `text-default`, `border-default` | Duplicated shadcn meanings and made authoring ambiguous. |
| Goose product tokens | `surface-composer`, `chip-agent-bg`, `canvas-base` | Useful, but mixed into the same layer as broad aliases. |

The practical result was that a component, the playground table, and the rendered Tailwind class could disagree about which token existed or which one meant "hover gray."

## Migration Choice

The chosen direction is **Tailwind + shadcn + small Goose extension layer**.

| Keep | Why |
| --- | --- |
| Tailwind utility classes | They keep implementation fast and consistent. |
| shadcn semantic tokens | They give humans and agents a standard meaning for shared component color choices. |
| Goose primitive palette | It preserves the current product feel. |
| Goose extension tokens | Some surfaces are product-specific and do not map cleanly to shadcn. |

| Remove | Why |
| --- | --- |
| `background-*` broad aliases | They duplicate shadcn `background`, `muted`, `accent`, `primary`, and `destructive`. |
| `text-*` broad aliases | They duplicate shadcn `foreground`, `muted-foreground`, and foreground pairs. |
| `border-*` broad aliases | They duplicate shadcn `border`, `input`, and `ring`. |
| Sidebar nav aliases | shadcn already has `sidebar-*` tokens for this job. |
| Overlay/card aliases | shadcn already has `popover` and `card`. |

## Current Token Layers

| Layer | Defined in | Used by |
| --- | --- | --- |
| Primitive color material | `@theme` in `src/shared/styles/globals.css` | Rare direct usage and semantic token values. |
| shadcn core runtime tokens | `:root` and dark theme block | Shared components and app UI. |
| shadcn sidebar runtime tokens | `:root` and dark theme block | Sidebar shell and sidebar row states. |
| Goose extensions | `:root` and dark theme block | Canvas, composer, chrome, chips, status, charts, project tint. |
| Tailwind utility bridge | `@theme inline` | Generates classes like `bg-accent`, `text-muted-foreground`, `bg-surface-composer`. |

`ThemeProvider` should not generate a replacement palette at runtime. It owns
mode, density, and the explicit primary-color override only; `globals.css`
owns the shadcn token values.

## Human Rules

| If you mean | Use |
| --- | --- |
| Default app surface | `bg-background text-foreground` |
| Stable contained panel | `bg-card text-card-foreground` |
| Floating inspector/menu/popover | `bg-popover text-popover-foreground` |
| Hover/active/selected gray fill | `bg-accent text-accent-foreground` |
| Quiet secondary text | `text-muted-foreground` |
| Primary action | `bg-primary text-primary-foreground` |
| Destructive action | `bg-destructive text-destructive-foreground` |
| Default structure | `border-border` |
| Input/control outline | `border-input` |
| Focus | `ring-ring` or `border-ring` |

## Goose Extension Rules

| If you mean | Use |
| --- | --- |
| App canvas/dot-grid background | `canvas-base`, `canvas-project-tint`, `dot-*` |
| Sidebar/app chrome glass | `sidebar` |
| Composer surface | `surface-composer`, `surface-composer-glass` |
| Composer placeholder | `text-placeholder-composer` |
| File/chat/project/agent/skill/automation chips | `chip-*-bg`, `chip-*-fg` |
| Non-destructive status | `success`, `warning`, `info` |
| Dark-on-light inverse popover | `popover-inverse` |

## Migration Result

The broad duplicate token families were removed from the Tailwind authoring surface. Component classes now map to shadcn names or to a small Goose extension where there is a real product-specific reason.

The design-system playground and generated component manifest were regenerated so the inspector and token tables describe the same vocabulary the components now use.
