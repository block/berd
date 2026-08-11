---
name: Berd
description: A desktop agent workspace documented from the actual Berd design-system tokens.
colors:
  bg-primary: "#1a1a1a"
  text-primary-foreground: "#ffffff"
  bg-background: "#ffffff"
  text-foreground: "#242424"
  bg-card: "#ffffff"
  bg-sidebar-accent: "#f5f5f5"
  bg-muted: "#f0f0f0"
  text-muted-foreground: "#7f7f7f"
  text-placeholder: "#cccccc"
  border-border: "#e8e8e8"
  border-input: "#e5e5e5"
  border-foreground: "#242424"
  bg-destructive: "#dc2626"
  bg-destructive-10: "color-mix(in oklab, #dc2626 10%, transparent)"
  text-destructive: "#dc2626"
  text-destructive-foreground: "#ffffff"
  text-success: "#73b468"
  text-info: "#5c98f9"
  text-warning: "#fbcd44"
typography:
  display:
    fontFamily: "font-display"
    fontSize: "text-6xl"
    fontWeight: "font-normal"
    lineHeight: "leading-none"
    letterSpacing: "tracking-tight"
  headline:
    fontFamily: "font-display"
    fontSize: "text-2xl"
    fontWeight: "font-normal"
    lineHeight: "leading-tight"
    letterSpacing: "tracking-tight"
  title:
    fontFamily: "font-display"
    fontSize: "text-lg"
    fontWeight: "font-semibold"
    lineHeight: "leading-none"
    letterSpacing: "tracking-tight"
  body:
    fontFamily: "font-sans"
    fontSize: "text-sm"
    fontWeight: "font-normal"
    lineHeight: "leading-relaxed"
  label:
    fontFamily: "font-sans"
    fontSize: "text-xs"
    fontWeight: "font-medium"
    lineHeight: "leading-none"
    letterSpacing: "tracking-wide"
rounded:
  rounded-xs: "6px"
  rounded-sm: "12px"
  rounded-md: "18px"
  rounded-lg: "24px"
  rounded-full: "999px"
  rounded-composer: "40px"
spacing:
  h-7: "1.75rem"
  h-8: "2rem"
  h-9: "2.25rem"
  h-10: "2.5rem"
  h-input: "3.25rem"
  h-input-sm: "2.75rem"
  h-button: "2.75rem"
  h-button-sm: "2rem"
  max-w-3xl: "48rem"
  max-w-5xl: "64rem"
  px-6: "1.5rem"
  py-8: "2rem"
components:
  button-primary:
    backgroundColor: "{colors.bg-primary}"
    textColor: "{colors.text-primary-foreground}"
    rounded: "{rounded.rounded-full}"
    height: "{spacing.h-9}"
    padding: "0 1rem"
  button-ghost-icon:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted-foreground}"
    rounded: "{rounded.rounded-full}"
    height: "{spacing.h-8}"
    width: "{spacing.h-8}"
  input-default:
    backgroundColor: "transparent"
    textColor: "{colors.text-foreground}"
    rounded: "{rounded.rounded-sm}"
    height: "2.25rem"
    padding: "0 0.75rem"
  chat-composer:
    backgroundColor: "{colors.bg-background}"
    textColor: "{colors.text-foreground}"
    rounded: "{rounded.rounded-composer}"
    padding: "1rem"
  card-default:
    backgroundColor: "{colors.bg-card}"
    textColor: "{colors.text-foreground}"
    rounded: "{rounded.rounded-md}"
    padding: "1.5rem"
  nav-item-active:
    backgroundColor: "{colors.bg-sidebar-accent}"
    textColor: "{colors.text-foreground}"
    rounded: "{rounded.rounded-sm}"
    padding: "0.375rem 0.75rem"
  badge-secondary:
    backgroundColor: "{colors.bg-muted}"
    textColor: "{colors.text-foreground}"
    rounded: "{rounded.rounded-xs}"
    padding: "0.125rem 0.5rem"
---

# Design System: Berd

## 1. Overview

**Creative North Star: "The Grounded Workbench"**

This file documents the actual Berd design-system source in [globals.css](src/shared/styles/globals.css), especially the `:root` semantic tokens and the Tailwind `@theme inline` aliases. The frontmatter lists the Tailwind-facing tokens agents should use in component code, such as `text-foreground`, `bg-background`, `border-border`, and `text-muted-foreground`. The prose explains the lower-level CSS variable chain behind them.

The current implementation provides useful product bones: semantic color tokens, shared UI primitives, a persistent sidebar, compact top bar, and a strong chat composer pattern. This document is not a blanket endorsement of every current surface. The Automations feature UI is explicitly excluded as design precedent because it did not receive the same craft pass.

The product should reject the PRODUCT.md anti-references directly: not a generic chatbot wrapper, not a dark terminal skin, not a dashboard stuffed with metrics, not a marketing site wearing product chrome, not novelty-first AI visuals, not oversized decorative cards, not vague "assistant magic" copy, and not a pile of disconnected settings pages.

**Key Characteristics:**

- Use Tailwind-facing design tokens in component code, then trace back to CSS variables only when changing the system itself.
- Keep product chrome quiet, dense, and legible.
- Treat the chat composer, sidebar, settings, projects, skills, extensions, agents, and onboarding as the canonical surfaces.
- Do not use Automations as a source for visual decisions.
- Improve `src/shared/styles/globals.css` and `src/shared/ui/` when the design system needs to evolve.

## 2. Colors

The source palette is a semantic token system backed by a gray scale and small state-color set. In React code, use the Tailwind-facing utility names. In `globals.css`, those utilities map through public aliases to lower-level semantic variables.

### Primary

- **`--primary`**: Primary action, selected context, and accent source. In light mode it resolves to `--color-gray-900`; in dark mode it resolves to `--color-white`.
- **`--primary-foreground`**: Foreground color on `--primary`.
- **`--foreground`**: Public foreground alias used by Tailwind class `text-foreground`; it resolves to `--foreground`.
- **`--accent`, `--accent-foreground`**: Hover and low-emphasis interactive fill tokens.

### Secondary

- **`--background`**: Default app surface.
- **`--card`**: Card and panel surface.
- **`--muted`**: Muted surface for badges, tabs, queued rows, and low-emphasis controls.
- **`--secondary`**: Stronger neutral fill used sparingly.
- **`--popover-inverse`**: Inverse menu surface for narrow cases, not a license to make the product feel like a terminal.

### Tertiary

- **`--destructive`, `--destructive-foreground`**: Danger, failure boundaries, and filled destructive action states.
- **`--success / 10%`, `--success`, `--success`**: Success and ready states.
- **`--info / 10%`, `--info`, `--info`**: Informational state and system feedback.
- **`--warning / 10%`, `--warning`, `--warning`**: Warning state.

### Neutral

- **`--border`, `--border / 80%`**: General structure, dividers, and low-emphasis separation.
- **`--input`**: Form and control boundaries.
- **`--foreground`, `--card-foreground`, `--popover-foreground`, `--primary-foreground`, `--secondary-foreground`, `--muted-foreground`, `--text-placeholder`**: Lower-level semantic text values.
- **`--sidebar-accent`, `--sidebar-accent-foreground`**: Left navigation row states. Hover and selected change only the fill; text and icons keep the same foreground.
- **`--foreground`, `--muted-foreground`, `--card-foreground`, `--popover-foreground`, `--primary-foreground`, `--secondary-foreground`**: Source text inputs that semantic text tokens consume.
- **`--ring`**: Focus border/ring color. Keep it a quiet neutral gray so focus is visible without becoming a black outline.

### Named Rules

**The Token Contract Rule.** Use the existing CSS variables and Tailwind aliases. In feature code, prefer classes like `text-foreground`, `text-muted-foreground`, `bg-background`, and `border-border`; in token work, understand that these map back to variables such as `--foreground`, `--muted-foreground`, `--background`, and `--border`, which in turn resolve to semantic values like `--foreground`.

**The Theme Provider Rule.** `ThemeProvider` may apply light/dark mode, density, and the explicit primary color override. It should not generate or overwrite the full shadcn token palette at runtime.

**The Raw-CSS Token Rule.** Some surfaces cannot be styled with a utility class on an element: pseudo-elements (`::selection`, `::-webkit-scrollbar-thumb`), the CSS Custom Highlight API, filters, and opacities. These keep a `:root`/dark semantic token (with both light and dark values) and are consumed with `var(...)` directly in `globals.css`. Do not bridge them into `@theme inline`, because no utility class could use the generated color. See [Tokens Consumed In Raw CSS](/docs/color-token-mapping.md#tokens-consumed-in-raw-css).

**The State Color Rule.** Red, green, blue, and yellow are for state, not decoration. If a color does not communicate status or selected context, remove it.

**The Neutral Migration Rule.** Current tokens include pure `#ffffff` and `#000000`. Future token work may tint those neutrals, but new surfaces should not introduce raw white or black outside the token layer.

**The No Automations Precedent Rule.** Do not copy color decisions from the Automations UI into shared guidance or new product surfaces.

## 3. Typography

**Display Font:** `font-display`.
**Body Font:** `font-sans`.
**Label/Mono Font:** `font-sans` for labels, `font-mono` for code, paths, terminal output, and identifiers.

The app font is **Inter**, self-hosted as variable fonts (optical size + weight axes, normal + italic) in `src/app/assets/fonts/` under the SIL Open Font License 1.1. `globals.css` maps `--font-sans` and `--font-display` to `"Inter"` with a system-font fallback stack. Inter's optical size axis adapts tracking automatically — body sizes render comfortably, display sizes render tighter — so do not add letter-spacing compensation in component code. The mono font is **Geist Mono**, self-hosted the same way and mapped through `--font-mono`. Cash Sans is not used or bundled anywhere — it is proprietary and must not be added to this externally distributed product.

### Hierarchy

- **Display** (`font-display text-6xl font-normal tracking-tight`): Home clock and rare first-run moments. Avoid display scale in settings, sidebars, lists, cards, or dense product panels.
- **Headline** (`font-display text-2xl font-normal tracking-tight`): Page and onboarding titles.
- **Title** (`font-display text-lg font-semibold tracking-tight`): Section headers and ordinary product page titles.
- **Body** (`font-sans text-sm font-normal leading-relaxed`): Default UI copy, descriptions, menus, and form help. Keep prose lines around 65 to 75 characters.
- **Label** (`font-sans text-xs font-medium tracking-wide`): Compact metadata, badges, uppercase group labels, and secondary controls.
- **Mono** (`font-mono`): Code, file paths, terminal output, stack traces, and technical identifiers only.

### Named Rules

**The Source Font Rule.** Component code should use `font-sans`, `font-display`, and `font-mono`. If a new typeface is required, install and map it in `globals.css` instead of hardcoding it in feature code.

**The Calm Scale Rule.** Product hierarchy should be tight. If text needs more importance, try placement, grouping, or weight before jumping to hero-scale type.

## 4. Elevation

Berd uses semantic shadow tokens plus borders and tonal layering. Most surfaces are flat at rest. Shadows appear on hover, popovers, dialogs, and overlays where depth clarifies stacking.

### Shadow Vocabulary

- **`--shadow-mini`** (`0 2px 8px rgba(76, 76, 76, 0.15)`): Small control affordance, badges, and lightweight raised feedback.
- **`--shadow-mini-inset`** (`0 1px 4px rgba(76, 76, 76, 0.1) inset`): Subtle inset treatment.
- **`--shadow-btn`** (`0 2px 8px rgba(76, 76, 76, 0.15)`): Button elevation when a variant explicitly needs it.
- **`--shadow-card`** (`0 2px 8px rgba(76, 76, 76, 0.15)`): Hover elevation for interactive cards.
- **`--shadow-elevated`** (`0 3px 12px rgba(76, 76, 76, 0.22)`): Raised surfaces that need more separation than a card.
- **`--shadow-popover`** (`0 8px 30px rgba(0, 0, 0, 0.12)`): Menus, dropdowns, command-like overlays, and transient panels.
- **`--shadow-modal`** (`0 20px 60px rgba(0, 0, 0, 0.2)`): Dialogs that block or redirect the current task.
- **`--shadow-kbd`** and **`--shadow-date-field-focus`**: Specialized component shadows.

### Named Rules

**The Flat First Rule.** Surfaces are flat unless the user is interacting with them or z-order would otherwise be unclear.

**The No Glass Rule.** Blur and translucent glass are not default elevation. The top bar may use subtle translucency as window chrome, but product panels should use solid tokenized surfaces.

## 5. Shape

Corner radii use a 5-step scale built on Tailwind's standard utility names: `rounded-xs`, `rounded-sm`, `rounded-md`, `rounded-lg`, and `rounded-full`. Each step differs by 6px so adjacent tokens nest concentrically.

| Token | Value | Tailwind class |
| --- | --- | --- |
| `--radius-xs` | 6px | `rounded-xs` |
| `--radius-sm` | 12px | `rounded-sm` |
| `--radius-md` | 18px | `rounded-md` |
| `--radius-lg` | 24px | `rounded-lg` |
| (built-in) | 999px | `rounded-full` |

**The Nesting Rule.** When one rounded surface sits inside another, drop one step on the scale and use 6px (`p-1.5`) of padding between them. The inner corner will be concentric with the outer corner. Cards inside modals nest as `md → sm`; sub-cards inside cards nest as `sm → xs`.

**Composer Exception.** `rounded-composer` (40px) is a deliberate one-off for the chat composer surface. Do not reuse it elsewhere; the composer is the app's signature component and earns its own token.

**Picking a Token.**

- `rounded-full` — buttons, chips, pills, inputs, avatars, any surface that should read as fully soft.
- `rounded-lg` (24px) — the largest scale container; outer cards or panels that dominate a region.
- `rounded-md` (18px) — default for cards, modals, dropdowns, popovers, tiles, and most non-pill surfaces.
- `rounded-sm` (12px) — surfaces nested inside `md` containers, small cards, sidebar nav items.
- `rounded-xs` (6px) — surfaces nested inside `sm` containers, micro chips, dense controls.

**Authoring rule.** Always use Tailwind's standard radius utility names. Do not invent new class names like `rounded-m` or `rounded-pill`; override values in `@theme inline` instead.

## 6. Components

### Buttons

Use [Button](src/shared/ui/button.tsx) and its variants before adding feature-level styling.

- **Shape:** `rounded-full` for all buttons — text and icon-only alike. The base `Button` applies this automatically; feature code should not override the radius. Buttons are exempt from the geometric nesting rule — their effective radius is half their height, not a scale step.
- **Primary:** `bg-primary text-primary-foreground`, mapping through semantic primary surface and readable-on-primary text tokens.
- **Sizing:** Use the `Button` `size` prop. Current variants map to `h-7`, `h-8`, `h-9`, and `h-10`.
- **Ghost icon buttons:** No hover fill for `variant="ghost"` plus icon sizes; they shift from muted text to foreground text.
- **Rule:** Add variants to `Button` when a reusable button treatment is missing.

### Chips

Use [Badge](src/shared/ui/badge.tsx), composer chips, or a shared variant.

- **Shape:** `rounded-xs` (6px). Badges and status chips deliberately differ from buttons in shape because they differ in semantic purpose — buttons are interactive controls and use `rounded-full` to read as "press me"; badges are static labels conveying state and use `rounded-xs` so they read as "tag" rather than "control." This affordance separation reduces the chance of users attempting to click a static status indicator.
- **Color:** `bg-muted`, `text-foreground`, `text-muted`, and state tokens when the chip communicates state.
- **State:** Removable context chips should stay compact and should not compete with the composer text field.

### Cards / Containers

Use [Card](src/shared/ui/card.tsx) only when a meaningful object boundary exists.

- **Shape:** `rounded-md` (18px) on the base `Card` primitive, matching the sidenav panel. Use `rounded-lg` (24px) for the largest framing cards and `rounded-sm` (12px) for sub-cards nested inside another card.
- **Color:** `bg-card text-card-foreground`, mapping through `--card` and `--card-foreground` to semantic card surface and text tokens.
- **Border:** `border-border`, mapping to `--border`.
- **Shadow:** `hover:shadow-card` only when the card is interactive.
- **Rule:** Do not use cards as the default page layout, and never nest cards.

### Inputs / Fields

Use [Input](src/shared/ui/input.tsx), shared textareas, or shared selector components.

- **Shape:** `rounded-input` for default inputs.
- **Color:** `border-input`, `hover:border-foreground/20`, `text-foreground`, and `placeholder:text-placeholder`.
- **Focus:** `focus-visible:border-ring` and `focus-visible:ring-ring`, using semantic focus tokens.
- **Error / Disabled:** `aria-invalid:border-destructive`; disabled controls reduce opacity and preserve layout.

### Navigation

Use the shared sidebar and nav item patterns as the baseline.

- **Sidebar items:** `bg-sidebar-nav-bg-hover` for hover/focus, `bg-sidebar-nav-bg-selected` for active/menu-open, stable nav foreground text, compact padding, `rounded-md`, and regular-weight labels via `--sidebar-nav-font-weight` / `SIDEBAR_NAV_TEXT_CLASS` (`text-sm font-normal`).
- **Top bar:** compact icon-only actions using `Button` ghost icon variants.
- **State:** Active state should be visible without relying on color alone.
- **Behavior:** Collapsed labels may fade and width-collapse, but navigation must remain keyboard and screen-reader legible.

### Chat Composer

The composer is the signature component and should receive the most craft.

- **Surface:** `bg-background`, `border-border`, and `rounded-2xl` in the current implementation.
- **Layout:** Max width `max-w-3xl`, centered, with internal structure for attachments, selected persona/skills, text entry, toolbar controls, voice, send, stop, and context usage.
- **Behavior:** File drop state uses tokenized muted surfaces and dashed border. Queued messages stay inline above the text area.
- **Rule:** The composer should show active agent, model, project, skills, attachments, voice state, send state, and context usage without feeling like a control panel.

### Overlays

Use Radix-backed shared primitives for dialogs, sheets, drawers, dropdowns, popovers, and tooltips.

- **Shape:** `rounded-overlay` for popovers and dropdowns, `rounded-modal` for dialogs.
- **Color:** `bg-popover text-popover-foreground` or `bg-background text-foreground`.
- **Motion:** Use existing open/close animations and durations (`--duration-fast`, `--duration-normal`, `--duration-slow`).
- **Modal Use:** Dialogs are for blocking decisions, destructive confirmation, or workflows that cannot remain inline.

## 7. Do's and Don'ts

### Do:

- **Do** use `src/shared/styles/globals.css` semantic tokens and `src/shared/ui/` primitives before writing feature-level visual classes.
- **Do** use existing authored token and utility names exactly: `text-foreground`, `text-muted-foreground`, `bg-background`, `border-border`, `font-sans`, `font-display`, `font-mono`, `rounded-card`, `rounded-input`, `rounded-full`, `shadow-card`, and the shared component props that wrap them.
- **Do** preserve context legibility: project, files, agent, model, provider, session state, and loading state should stay visible where they affect the user's next action.
- **Do** keep color restrained. Use semantic state color only when it communicates state.
- **Do** treat settings, providers, extensions, skills, agents, projects, and onboarding as first-class workflow surfaces.
- **Do** change the design system first when a new token, font, radius, component variant, or motion pattern is needed.

### Don't:

- **Don't** use the Automations feature UI as design precedent for new product work.
- **Don't** invent friendly alias tokens like "ink" or "paper" in docs, components, or feature code.
- **Don't** make Berd feel like a generic chatbot wrapper.
- **Don't** make it feel like a dark terminal skin.
- **Don't** create a dashboard stuffed with metrics.
- **Don't** create a marketing site wearing product chrome.
- **Don't** use novelty-first AI visuals, oversized decorative cards, or vague "assistant magic" copy.
- **Don't** let settings become a pile of disconnected pages.
- **Don't** introduce new raw `#ffffff` or `#000000` values outside the current token layer.
- **Don't** use side-stripe borders, gradient text, decorative glassmorphism, hero-metric templates, identical card grids, or modal-first UX.
