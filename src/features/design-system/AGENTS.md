# Design System Explorer

This folder contains the in-app Goose Design System Explorer. Treat it as a real
product surface, not a docs dump.

## Repeatable Component Page Contract

Every component page should use the same structure unless Morgan explicitly asks
for a different treatment:

1. `PageIntro` with a short human-readable purpose.
2. `ComponentSpec` using the component name. This pulls source, variants, and
   slots from the generated manifest. Do not hand-write those facts.
3. `ComponentPlayground` for the live component preview and controls.
4. `ComponentTokenDetails` for the current preview's color states and text
   styling.

The generated manifest owns facts that can be read from code: source file,
exports, `data-slot`s, CVA variants, state classes, token classes, and source
token classes. The page owns designer judgment: what the preview should render,
which controls matter, anatomy labels, state rows, and the plain-language
description.

## Populating Component Pages

The manifest is an inventory scanner, not a page generator. Use it to keep
generated facts honest and to prevent docs drift, but do not expect it to infer
the best live demo.

When populating a component page:

- Always use `ComponentSpec` for manifest-owned facts. Do not duplicate source
  paths, slots, variants, or generated token facts by hand.
- Render the actual shared UI primitive in the playground whenever it can be
  safely shown in-page. A manifest summary card is only a fallback for helper
  modules or components that cannot be meaningfully rendered without app state.
- Author playground controls around meaningful product states, even when the
  manifest reports `Variants: None`. Useful controls may include selected value,
  open/closed, disabled, invalid, loading, placeholder text, option count,
  orientation, density-sensitive size, or empty state.
- For trigger/portal components, include the full composition, not only the
  trigger. For example, a Dialog playground needs `DialogTrigger` and
  `DialogContent`; a Popover playground needs `PopoverTrigger` and
  `PopoverContent`.
- Keep the token details aligned to the current preview state. If a control
  changes disabled, invalid, open, selected, or destructive state, the token
  rows should describe that state.

## Playground Control Heuristics

Playground controls should help designers inspect meaningful component behavior,
not turn the preview into a remote-controlled demo.

- Prefer controls for props, modes, composition choices, and states that cannot
  be easily inspected by directly interacting with the preview.
- Do not add a control for state the user can naturally change in the preview,
  such as an accordion's open section, unless the state is otherwise hard to
  reach or compare.
- Keep controls scoped to real component API or real product states. Do not
  invent visual variants just to fill the control panel.
- Do not add scenario/content presets when they only swap demo copy. Add them
  only when each preset exposes a distinct component behavior, layout stress, or
  product state.
- Hide controls when they do not apply to the selected mode instead of showing a
  disabled control with unclear meaning.
- Remove impossible options when another control changes the valid state space.
  For example, if a single accordion cannot collapse, the open-section choices
  should not include `None`.
- Use the smallest set of controls that explains the component. A strong page
  usually exposes 3-6 high-signal controls rather than every possible state.

## Token Table Rules

- Color rows answer: what background, text/icon, and border color is visible for
  each anatomy/state combination?
- Text rows answer: what typography styling is visible? Keep color out of the
  text table.
- Do not show visible label text as token metadata.
- Do not show raw Tailwind utility pills in the Tokens section.
- Prefer explicit values over vague values like `inherited`,
  `state-dependent`, or `disabled opacity`.
- Disabled states should name the base token plus opacity, for example
  `--foreground / 50%`.

## Token Usage

Component source should use the shadcn semantic token contract first:
`bg-background`, `text-foreground`, `bg-card`, `bg-popover`, `bg-muted`,
`text-muted-foreground`, `bg-accent`, `bg-primary`, `bg-destructive`,
`border-border`, `border-input`, and `ring-ring`.

Use Goose extension tokens only for product-specific surfaces and identities,
such as `bg-surface-composer`, `bg-canvas-base`, chip colors, status colors,
and composer placeholder color. Use `bg-card-glass` for floating chrome glass
(nav panes, right rail, the global composer pill).

Do not use raw palette utilities like `bg-gray-100`, direct hex colors, or
component-specific one-off color tokens without first adding them to the design
system.

## Validation

After changing component source or explorer pages, run:

```bash
pnpm design-system:generate
pnpm design-system:coverage
just check
```

Then visually verify the changed page in the in-app explorer.
