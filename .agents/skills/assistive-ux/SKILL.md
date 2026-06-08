---
name: assistive-ux
description: Use when adding, reviewing, designing, testing, or managing Assistive UX moments in Goose Internal, including discover, suggest, and autoApply guidance, adaptive settings, behavior signals, retirement rules, or changes under src/shared/assistive-ux.
---

# Assistive UX

Use this skill for Goose Internal product intelligence moments that teach,
suggest, or adapt settings based on user behavior.

Before changing code, read `docs/assistive-ux.md`. Treat that doc as the source
of product intent and architecture.

## Core Rule

Keep assistive state separate from user settings:

```text
User settings answer: what should the product do?
Assistive UX answers: what has the app shown, observed, accepted, retired, or applied?
```

Do not store guidance lifecycle state inside a feature setting. Do not use
assistive state as the source of truth for product behavior.

## Types

- `discover`: teaches that a control, setting, or capability exists. It should
  not change settings.
- `suggest`: notices a repeated behavior and asks before changing a setting.
- `autoApply`: changes a reversible local setting only after strong evidence,
  then explains the change and offers undo.

Use `autoApply` conservatively. Never auto-apply changes involving secrets,
credentials, permissions, destructive actions, provider setup, billing-like
behavior, or hard-to-reverse choices.

## Implementation Workflow

1. Define or update the rule in `src/shared/assistive-ux/registry.ts`.
2. Keep lifecycle reads and writes in `src/shared/assistive-ux/runtime.ts` and
   `src/shared/assistive-ux/state.ts`.
3. Render the moment from the relevant feature surface.
4. Retire the moment when the user accepts it, dismisses it, sees it enough
   times, or manually changes the related setting.
5. If the moment changes a setting, call the setting's public setter and provide
   an undo path when the change is automatic.
6. Keep stored signals coarse. Do not store chat text, file paths, provider
   secrets, credentials, or message contents.

## UX Checklist

Before shipping, confirm:

- The moment appears close to the behavior it helps with.
- The copy explains the next action without selling the feature.
- The primary workflow still has visual priority.
- The moment has a clear retirement path.
- Repeated exposure is capped.
- Manual setting changes stop or reset related guidance.
- The behavior works in light and dark themes.

## Testing

Add focused tests for:

- fresh eligibility
- shown-count updates
- max-show expiration
- acceptance or dismissal retirement
- related setting-change retirement
- invalid localStorage fallback
- any feature surface that renders or applies the moment

For broad behavior, add Playwright coverage only when the flow benefits from
real app navigation or persistence across reloads.
