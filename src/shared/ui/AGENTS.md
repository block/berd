# Shared UI Design System

Use the primitives in `src/shared/ui/` as the default way to build interface elements. Prefer extending these components over recreating their styling in feature code.

## Core Rules

- Prefer shared UI primitives over custom markup plus Tailwind classes.
- Prefer adding a variant or prop to a shared component over one-off styling in feature code.
- Keep feature code focused on composition, state, and content. Visual treatment should usually live in `src/shared/ui/`.
- If a pattern appears in more than one place, extract or extend a shared primitive instead of copying class strings.

## Button sizing rule

**All buttons within a single surface zone must use the same `size`.**
Footer buttons in dialogs are the default Button size. Toolbar buttons are
`xs`. Page-level actions are `default`. Never mix sizes within a footer,
toolbar, or inline button group — if one button needs to be smaller, the
whole group steps down together.



The button system is a closed menu. Every button in the app is one of these
named things — never a custom-styled Button.

### The semantic menu (Button variants)

| Variant | Use when |
| --- | --- |
| `primary` | The one main action (save, create, submit, confirm). Filled. |
| `outline` | The paired secondary action next to a primary. Bordered. |
| `subtle` | Soft-fill mid-weight action on background-colored surfaces. |
| `ghost` | Quiet action in a row or toolbar. Invisible until hover. |
| `alert` | Action inside a colored alert/banner; inherits `currentColor`. |
| `link` | Inline text link that behaves as a button. Collapses to text. |

Two flags modify variants:

- `destructive` — danger intent. Works on `primary` (red fill), `outline`
  (red border/text), `subtle` (red tinted fill), and `ghost` (red text +
  tint hover). Other variants ignore it and warn in dev.
- `flush` — ghost only. Inline geometry: no padding pill; rests at
  `muted-foreground` and raises the label on hover. For quiet actions that
  sit flush with surrounding content (list section actions, "show more").

Pick the emphasis first; if the action is dangerous, add `destructive`.

### Chrome buttons (named wrappers)

Surface-specific recipes live in named components that compose Button. Use
these instead of restyling Button for app chrome:

| Component | Base | Use when |
| --- | --- | --- |
| `TopBarIconButton` | ghost | Icon actions in the app top bar / window chrome. |
| `ComposerActionButton` | subtle | Controls on the chat composer surface. |
| `PageHeaderButton` | subtle | View-header actions in the app top strip. |
| `AgentTileButton` | subtle | Actions floating over agent/persona tiles. |
| `GlassButton` | subtle | Controls floating over media, canvases, artwork. |
| `JumpToLatestButton` | primary | Floating back-to-live-edge pills over streams. |
| `DisclosureButton` | ghost | "View more" / "View less" / "View all" affordances. Pick a `surface`. |

Each wrapper's recipe owns all of its interactive states; see the doc
comment in its source for the full contract.

`DisclosureButton` takes a `surface` (`default` | `sidebar` | `sidebarRow`)
because how quiet the rest state can afford to be depends on what the button
sits on. `default` inherits the system `ghost + flush` states and is correct on
tinted raised surfaces like the chat user bubble; the `sidebar*` surfaces dim to
`muted-foreground/75`, which is only legible against the page background. Do not
use a `sidebar*` surface on a tinted surface.

### The rule (audited in CI)

Feature code never puts color or interactive-state classes (`bg-*`,
`text-foreground`/`text-muted-foreground`/..., `hover:*`, `active:*`,
`shadow-*`, `opacity-*`) on a `<Button>`. Layout-only classes (`ml-auto`,
`w-full`, `justify-start`, `shrink-0`, truncation) are fine. If no variant,
flag, or wrapper fits, that is a design-system conversation — extend the
menu, don't restyle locally. `pnpm design-system:audit` enforces this and
fails on new violations.

### General guidance

- Use `Button` for clickable controls unless there is a strong reason not to.
- Use `variant` and `size` before adding custom classes.
- Use `leftIcon` and `rightIcon` for leading and trailing icons instead of manually placing icon children.
- Do not add spacing classes only to position button icons unless the design system cannot express the pattern yet.
- For icon-only actions, use the `icon-*` sizes instead of text button sizes.
- For active icon-only buttons, prefer native hover via `title` plus `aria-label`.
- Reserve custom `Tooltip` for disabled controls or richer explanatory content.
- Use `Button` for async action feedback too. Prefer its `feedbackState`,
  `loadingLabel`, `successLabel`, `errorLabel`, `loadingVisual`, and
  `preserveWidth` props over creating a separate async button wrapper or
  hand-placing spinners in feature code.
- When combining async feedback with `asChild`, keep the visible label inside
  the slotted child so `Button` can swap it with loading, success, or error
  feedback.

### Ghost icon buttons

`variant="ghost"` has compound variants for all `icon-*` sizes that set `hover:bg-transparent hover:text-foreground`. This means ghost icon buttons have no background fill on hover — only a color change. Do not add `hover:bg-accent/50` or similar hover background classes to ghost icon buttons; the compound variant already provides the correct behavior. Layout classes like `mr-1`, `size-6`, `flex-shrink-0` are fine to add.

## Icon Sizing

- Let `Button` size button icons by default.
- Current button icon defaults are tied to button size:
- `xs` and `sm` buttons use `size-3` icons.
- `default` buttons use `size-3.5` icons.
- `lg` buttons use `size-4` icons.
- Only give an icon its own explicit `size-*` class when intentionally overriding the design-system default.
- Match icon visual weight to the text and control size. Small toolbar controls should not use oversized icons.

## Dialogs

There is **one** modal surface: `Dialog`. Do not create new dialog chrome
components; compose the anatomy the use case needs.

- `DialogContent` owns the glass surface, close button, and width via the
  `size` prop (`md` | `lg` | `xl`). Do not pass ad-hoc `max-w-*` classes.
- Simple dialogs: `DialogHeader` + content + `DialogFooter`. Everything
  scrolls together.
- Content-heavy dialogs (forms, pickers, lists): wrap the middle in
  `DialogBody`. Its presence automatically pins the header and footer,
  moves padding to the zones, and gives the footer its top divider. Use
  `DialogBody asChild` with a `<form>` child when the body is a single form.
- **All dialog actions live in `DialogFooter` and use `Button` directly.**
  Do not create wrapper buttons for back/save/delete. Back is just
  `<Button variant="ghost" flush className="sm:mr-auto" />`.
  Submit/save buttons use default Button size in the footer; if the body is
  a form, submit with `<Button form={formId} type="submit">`.
- Semantic variants are the only other dialog components: `AlertDialog`
  (interruptive, no light-dismiss), `ConfirmDialog` (yes/no preset), and
  `CommandDialog` (search-first palette). Never fork a new one for content
  density — density is `size` + `DialogBody`, not a new component.
- Name feature dialogs `*Dialog`, not `*Modal`.
- List rows inside dialogs and settings use `RowButton` (`menu` variant for
  borderless option rows, `field` for bordered input-like triggers) instead
  of raw `<button>` + hand-rolled classes. Hover states come from the
  primitive (`bg-muted`); do not use washed-out one-offs like
  `hover:bg-accent/30`.

## Menus And Selectors

- Compose menus from `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, and related shared primitives.
- When a trigger behaves like a button, use `Button` as the trigger surface.
- Repeated trigger patterns like icon + label + chevron should be expressed through shared props or shared wrapper components.

## Styling Boundaries

- Avoid introducing custom colors, spacing, radii, or typography in feature code when existing tokens and shared variants cover the need.
- If a control needs a new visual treatment, add it to the shared component API first.
- Keep accessibility built in: semantic elements, labels for icon-only buttons, and consistent focus states.

## Good Heuristic

Before writing custom classes in a feature, ask:

1. Can an existing shared component already do this?
2. Should this become a shared variant or prop?
3. Will another screen likely need the same pattern?
