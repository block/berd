# Assistive UX

Date: 2026-06-08

## Summary

Assistive UX is a product and architecture pattern for moments where Berd helps
users shape the app around their work. These moments can teach that a control
exists, suggest a better default, or change a setting after the app has strong
evidence that the user wants that behavior.

The goal is not to add more tips. The goal is to make Berd attentive without
being intrusive:

```text
Observe behavior.
Offer help at the moment it is relevant.
Retire the help when the user has learned, declined, or changed the setting.
Keep the user's settings separate from the app's memory of guidance.
```

Assistive UX should feel like a calm product intelligence layer. It should make
configuration feel connected to the workflow, while preserving user control and
making every automatic change reversible.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Assistive UX | The umbrella system for guidance, suggestions, and adaptive settings. |
| Moment | A user-facing assistive intervention that appears in a surface, such as a toast, banner, inline prompt, or settings row. |
| Rule | The product logic that decides when a moment is eligible, retired, accepted, or applied. |
| Signal | A recorded user behavior that may contribute to future guidance. |
| Assistive state | The local record of what the app has shown, accepted, retired, suggested, or applied. |
| User setting | The actual product preference the user controls. This remains separate from assistive state. |

## Types

Assistive UX has three types.

### Discover

`discover` teaches that a control, setting, or capability exists.

Use this when the user has just experienced the result of a feature and is in a
good moment to learn that it is configurable. A discover moment should be small,
temporary, and easy to ignore.

Good discover behavior:

```text
show only a limited number of times
retire when clicked
retire when the related setting changes
retire after enough exposures
```

Discover moments should not change user settings. They only help users find the
control.

### Suggest

`suggest` notices a repeated behavior and asks before changing a setting.

Use this when the app has enough evidence to make a useful recommendation, but
not enough confidence to change behavior on the user's behalf. A suggest moment
should explain the proposed change in plain language and provide a clear accept
or dismiss path.

Good suggest behavior:

```text
trigger only after a meaningful pattern
avoid repeated prompting after dismissal
apply the setting only after explicit acceptance
make the related setting easy to find later
```

Suggest moments should be conservative. If a recommendation would surprise a
reasonable user, ask first.

### Auto Apply

`autoApply` changes a setting after strong behavioral evidence, then explains
what changed and offers undo.

Use this only when the pattern is clear, the change is low risk, and undo is
obvious. Auto apply should feel like the app removed friction the user was
already working around, not like the app guessed at intent.

Good auto apply behavior:

```text
require a stronger signal threshold than suggest
change only reversible, local preferences
show a confirmation with undo
record why the change happened
stop applying once the user manually changes the setting
```

Auto apply should never touch secrets, credentials, permissions, destructive
actions, provider setup, billing-like behavior, or anything that would be hard
to reverse.

## Architecture

Assistive UX should live under one shared umbrella instead of being implemented
as one-off local state inside each feature.

Recommended shape:

```text
src/shared/assistive-ux/
  registry.ts       stable rule definitions and ids
  state.ts          local persistence, parsing, migration, writes
  runtime.ts        shouldShow, recordShown, recordAccepted, recordRetired
  signals.ts        helpers for behavior counters and observations
```

The exact file names can evolve, but the ownership boundary should stay stable:

```text
Feature surfaces render moments.
Feature settings own user preferences.
Assistive UX owns guidance lifecycle state.
APIs own side effects outside the renderer.
```

This keeps the actual setting clean. A setting answers, "what does the user want
the product to do?" Assistive state answers, "what has the app already taught,
suggested, observed, accepted, retired, or applied?"

## State Model

Assistive UX state should be stored separately from feature settings.

For renderer-local behavior, use a single local storage umbrella:

```text
goose:assistive-ux
```

The stored state should be versioned, resilient to invalid data, and safe to
ignore if local storage is unavailable.

Suggested conceptual shape:

```text
version
moments:
  by id:
    type
    shownCount
    acceptedAt
    retiredAt
    retiredReason
    lastShownAt
signals:
  by id:
    counters
    lastObservedAt
applied:
  by id:
    appliedAt
    undoAvailable
    reason
```

The state should not store sensitive content. Signals should be coarse product
behavior counts, not chat text, file paths, provider secrets, or message
contents.

## Lifecycle

Every assistive rule should define its full lifecycle.

```text
Eligible:
  The surrounding product state makes the moment relevant.

Shown:
  The user saw the moment. Count this so the app can retire repeated teaching.

Accepted:
  The user clicked the assistive action or accepted the recommendation.

Dismissed:
  The user rejected or ignored the recommendation in a way that should reduce
  future prompting.

Retired:
  The moment should no longer appear because it has taught enough, the user
  acted on it, the user changed the related setting, or it expired.

Applied:
  The system changed a setting for the user.

Undone:
  The user reversed an applied setting change.
```

Rules should be explicit about which events retire a moment. Good retirement is
what keeps assistive UX from becoming nagging UX.

## Relationship to Settings

Assistive UX may read settings and may call the same public setters a settings
screen uses, but it should not own settings.

Allowed:

```text
read a setting to decide whether guidance is relevant
open the related settings section
call a public setting setter after user acceptance
retire a moment when a related setting changes
offer undo after an auto-applied setting change
```

Avoid:

```text
store assistive state inside the setting object
hide user settings behind guidance-only logic
change settings without a public setter or undo path
use assistive state as a source of truth for product behavior
```

If a user manually changes a related setting, that manual choice should usually
retire or reset related assistive UX. Manual settings changes are strong
evidence that the user understands the control.

## Product Principles

Assistive UX should follow these rules:

- Be timely. Appear close to the behavior or outcome it is helping with.
- Be scarce. A moment that appears too often becomes noise.
- Be proportional. Teaching can be lightweight; automatic changes need more
  evidence and undo.
- Be local and reversible. Personal workflow adaptation should stay local unless
  there is a clear product reason to sync it.
- Be explainable. The user should understand why the app is suggesting or
  changing something.
- Be respectful. Do not interrupt active work for low-value guidance.
- Be durable. Once the user has learned, accepted, dismissed, or manually
  configured the related behavior, stop showing the same moment.

## Implementation Guidelines

When adding a new assistive rule, define:

```text
id
type
eligibility
signals observed
threshold
surface
copy
action
retirement conditions
settings touched
undo behavior, if any
tests
```

For `discover`, threshold usually means a small maximum show count.

For `suggest`, threshold means enough repeated behavior to justify asking.

For `autoApply`, threshold means strong evidence, low risk, and a reliable undo
path.

Feature teams should prefer public helper functions such as:

```text
shouldShowAssistiveMoment(id)
recordAssistiveMomentShown(id)
recordAssistiveMomentAccepted(id)
recordAssistiveMomentRetired(id, reason)
recordAssistiveSignal(id, payload)
recordAssistiveAutoApply(id, details)
```

The actual API can be shorter, but it should preserve this separation:
eligibility, display, acceptance, retirement, signals, and applied changes.

## Validation

Assistive UX rules should be tested as product behavior, not only as storage
helpers.

Validate:

- The moment appears only when eligible.
- The moment increments show count when displayed.
- The moment stops appearing after its show limit.
- The moment retires when accepted.
- The moment retires when the related setting changes.
- Suggestions do not apply settings before acceptance.
- Auto-applied settings show undo.
- Undo restores the previous setting.
- Invalid stored state falls back safely.
- Local storage failures do not break the product surface.

Manual QA should include the related settings page, the surface where the moment
appears, and at least one app restart to confirm persistence.

## Examples

These examples are illustrative. They are not the architecture itself.

### Discover Example

A completion toast includes a secondary action that opens the relevant settings
section. It appears only for the first few eligible toasts. It retires when the
user clicks it, when the related setting changes, or when the show limit is
reached.

### Suggest Example

The app notices that a user repeatedly chooses a faster interaction pattern
during an active workflow. It asks whether that behavior should become the
default. The setting changes only if the user accepts the suggestion.

### Auto Apply Example

The app observes a strong, repeated pattern where the user consistently corrects
the same default behavior. It changes the local setting, shows a confirmation
toast explaining the change, and offers undo.
