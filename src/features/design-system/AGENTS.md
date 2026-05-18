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
  `--text-default / 50%`.

## Source vs Semantic Tokens

Component source should use semantic tokens, not source-token utility names like
`bg-background`, `text-foreground`, `bg-muted`, `text-muted-foreground`,
`border-input`, or `bg-border`.

If a component needs a token that does not exist yet, propose or add a semantic
token first, then use it in the component. Do not add app-specific source tokens
for a one-off component state.

## Validation

After changing component source or explorer pages, run:

```bash
pnpm design-system:generate
pnpm design-system:coverage
just check
```

Then visually verify the changed page in the in-app explorer.
