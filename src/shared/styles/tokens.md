# Design Tokens

Source of truth: [globals.css](./globals.css).

This file documents the reskin foundation tokens added before any product
surface rewrites. The intent is to make later PRs consume named design-system
decisions instead of introducing one-off colors, radii, or background recipes.

## Layers

1. Primitives live in `@theme` as constant `--color-*` values.
2. Semantic tokens live in `:root` and `.dark`.
3. Tailwind bridges live in `@theme inline` as generated utilities like
   `bg-surface-chrome`, `text-foreground-subtle`, and `rounded-composer`.

When adding a token, add all applicable pieces together: light value, dark value,
Tailwind bridge, and this documentation.

## Theme Source Of Truth

`ThemeProvider` owns the resolved app color mode. It applies `.light` or `.dark`
to `document.documentElement`, including when the user chooses `System` and the
app follows the operating system preference.

Keep token CSS aligned to that contract:

```css
@custom-variant dark (&:is(.dark *));
```

Do not add `[data-theme="dark"]` or other parallel theme selectors unless the
theme contract is intentionally migrated in `ThemeProvider` and covered by
tests. A second selector can create split-brain behavior where one root marker
says light and another says dark.

## Canvas And Surfaces

| Token | Utility | Use |
| --- | --- | --- |
| `--canvas-base` | `bg-canvas-base` | Base app canvas for reskinned surfaces. |
| `--canvas-project-tint` | `bg-canvas-project-tint` | Default project-context canvas tint. |
| `--surface-chrome` | `bg-surface-chrome` | Floating app chrome such as sidebar/top controls. |
| `--surface-card` | `bg-surface-card` | Content cards and modal bodies. |
| `--surface-card-soft` | `bg-surface-card-soft` | Softer cards layered on canvas. |
| `--surface-overlay` | `bg-surface-overlay` | Popovers, menus, and overlays. |
| `--surface-tile` | `bg-surface-tile` | Inset tiles, compact rows, and chips. |
| `--surface-composer` | `bg-surface-composer` | Translucent composer surfaces. |
| `--surface-button` | `bg-surface-button` | Filled neutral buttons. |
| `--surface-install` | `bg-surface-install` | Install/setup surfaces. |

`--backdrop-composer-glass` is a shared backdrop-filter recipe for glassy
composer surfaces. Use it only where a component already needs a custom
`backdrop-filter` style.

## Dot Grid

`.bg-dot-grid` is a concrete utility class, not a generated Tailwind utility. It
uses:

| Token | Use |
| --- | --- |
| `--project-tint` | Optional wrapper-level tint. Defaults to transparent. |
| `--dot-color-base` | Untinted dot color for the current theme. |
| `--dot-size` | Dot radius. |
| `--dot-spacing` | Grid spacing. |

Set `--project-tint` on a wrapper to tint both the canvas and the dots together.

## Text

| Token | Utility | Use |
| --- | --- | --- |
| `--text-subtle` | `text-foreground-subtle` or `text-text-subtle` | Secondary text. |
| `--text-title` | `text-text-title` | Page and section titles. |
| `--text-breadcrumb-separator` | `text-text-breadcrumb-separator` | Breadcrumb separators. |
| `--text-placeholder-composer` | `text-text-placeholder-composer` | Placeholder text on translucent composer surfaces. |

Existing tokens such as `text-muted`, `text-primary`, and `text-danger` remain
the preferred choices where they already match the intent.

## Chips And Pills

Decorative pill primitives are available as `bg-pill-pink`, `bg-pill-olive`,
`bg-pill-blue`, `bg-pill-lavender`, `bg-pill-sage`, `bg-pill-mint`,
`bg-pill-peach`, and `bg-pill-neutral`.

Entity chip tones use paired foreground/background utilities:

| Tone | Utilities |
| --- | --- |
| File | `bg-chip-file-bg text-chip-file-fg` |
| Agent | `bg-chip-agent-bg text-chip-agent-fg` |
| Skill | `bg-chip-skill-bg text-chip-skill-fg` |
| Automation | `bg-chip-automation-bg text-chip-automation-fg` |

## Shape

| Token | Utility | Use |
| --- | --- | --- |
| `--radius-pill` | `rounded-pill` | Pills, chips, compact controls. |
| `--radius-button` | `rounded-button` | Button alias. |
| `--radius-input` | `rounded-input` | Input alias. |
| `--radius-chrome` | `rounded-chrome` | Floating chrome panels. |
| `--radius-card` | `rounded-card` | Standard cards. |
| `--radius-card-chat` | `rounded-card-chat` | Chat cards and message pills. |
| `--radius-composer` | `rounded-composer` | Composer containers. |
| `--radius-tile` | `rounded-tile` | Tiles and inset rows. |
| `--radius-dropdown` | `rounded-dropdown` | Menus and dropdowns. |
| `--radius-overlay` | `rounded-overlay` | Overlays. |
| `--radius-modal` | `rounded-modal` | Dialog surfaces. |

## Type Sizes

Role-named app chrome sizes are available as `text-label-alex`,
`text-body-alex`, `text-input-alex`, and `text-title-alex`.

These do not change the global font family. Typography and font loading should
be handled in a separate, explicit product/design decision.
