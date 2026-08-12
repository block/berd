# Composable Capabilities

Date: 2026-06-05  
Updated: 2026-06-27

## Summary

Berd should support both beginners and pro engineers without forcing every
workflow into a separate hard-coded screen. The codebase should make product
surfaces composable: a team-authored view can combine reusable product
capabilities today, and a future user-authored view builder can reuse the same
contracts later if that product direction proves useful.

The architecture goal is:

```text
design-system primitives
  down to
feature-owned capabilities
  down to
composed product views and surfaces
```

The core rule:

```text
Views compose capabilities.
Capabilities own product behavior.
Shared UI owns visual primitives.
APIs own side effects.
The registry describes what exists; it does not own runtime state.
```

This is not a rewrite plan. It is a migration direction for new feature work and
a guide for gradually untangling existing screens when we touch them.

## Mental Model

The folder names can be confusing because `feature` and `capability` answer
different questions.

```text
Feature = who owns the code.
Capability = what reusable product behavior that code offers.
Surface/View = where that behavior appears.
```

A product area can be both a feature and a capability in normal conversation. For
example, "the terminal" is a product capability, but its code can still live in
`src/features/terminal/` because the terminal feature owns the terminal behavior.

Example:

```text
src/features/terminal/
  api/              Tauri/backend terminal side effects
  lib/              terminal lifecycle and state helpers
  ui/               terminal visual pieces
  capabilities/     reusable terminal capability entry points
```

Read that as:

```text
The terminal-owned feature folder exposes one or more reusable terminal
capabilities.
```

Not:

```text
Terminal is only a feature and therefore cannot be a capability.
```

## Vocabulary

| Term | Meaning | Example |
| --- | --- | --- |
| Component | Mostly visual UI. It should not own product workflow logic. | Button, dialog, tabs, empty state, status chip |
| Capability | A reusable product unit that bundles data needs, actions, states, and render modes. | Terminal, conversation composer, pull request summary |
| Capability registry | A thin app-level catalog of capability contracts and entry points. It is not a global state store. | `terminal` descriptor |
| View | A composed screen, panel, or workflow surface made from capabilities. | Chat view, home, PR inbox, project workspace |
| Surface | A place or density where a capability can appear. | Bottom dock, right rail, floating panel, home pill, chat footer |
| Render mode | A capability-owned way to render for a surface or density. | `bottomDock`, `floating`, `rightRail`, `home`, `chatFooter` |
| Control policy | Explicit availability for optional actions or controls in a render mode. | Model picker visible/hidden, attachments enabled/disabled |
| API | The boundary that talks to Tauri, ACP, GitHub, local storage, or external services. | Start a terminal, submit a message, fetch PRs |
| Model | Product rules and state definitions that are not tied to a visual layout. | Terminal tab rules, composer disabled states, PR status rules |

The important distinction: a capability is not just a bigger component. It owns
enough behavior to work correctly wherever it is rendered.

## Naming Guidance

Capability names should use the simplest durable product noun. Prefer the name a
designer or user would naturally say over an implementation-shaped name.

Good capability names:

```text
Terminal
Conversation Composer
Session List
Context Rail
Pull Request Summary
```

Avoid adding scope words just to explain the implementation:

```text
Terminal Workspace
Chat Footer Composer Module
Right Rail Terminal Tool
```

Use more specific names underneath the capability when they clarify internal
parts or render modes:

```text
Capability: Terminal
  TerminalSession      one backend shell process
  TerminalTab          one tab inside the terminal
  TerminalPanel        the raw xterm renderer
  TerminalBottomDock   bottom-dock render mode
  TerminalFloatingPanel floating render mode
  TerminalRightRailTile right-rail render mode
```

Registry ids should follow the same principle. Use the short product noun when
there is one obvious capability:

```text
terminal
conversationComposer
sessionList
```

Use dotted ids only when a feature exposes multiple distinct capabilities:

```text
terminal.runningIndicator
terminal.commandLauncher
```

A capability name should not depend on its current screen location. If the name
only makes sense because the thing lives in the bottom dock, right rail, home, or
chat footer, it is probably a render mode or surface name rather than the
capability name.

## Why This Matters

Berd's product vision is progressive disclosure. A beginner may need a simple
surface with one clear action. A pro engineer may need a dense workspace with
multiple tools, status, context, and agent help visible at once.

Those should not become unrelated implementations.

For example, the conversation composer currently appears in multiple places:

```text
Home composer
Main chat composer
Agent builder composer
```

Those surfaces can look different, like design-system variants, but they should
not each reimplement the product rules for drafting, sending, stopping,
attachments, skills, model selection, queued messages, or disabled states.

The target direction is:

```text
ConversationComposerCapability
  render mode: home
  render mode: chatFooter
  render mode: agentBuilder

Each render mode can have different chrome, density, and control availability.
The capability still owns the shared product behavior.
```

## Global Registry Direction

Berd should start moving toward a global capability registry, but the registry
should be intentionally thin.

The registry is a catalog:

```text
What capabilities exist?
Who owns them?
What context do they need?
What render modes do they support?
What product states and actions do they expose?
```

The registry is not a capability store:

```text
It should not own open terminal tabs.
It should not own composer drafts.
It should not own current session runtime.
It should not become a second app state system.
It should not become a plugin framework before the product needs one.
```

A useful first shape is static TypeScript metadata:

```text
src/app/capabilities/
  types.ts
  registry.ts

src/features/terminal/capabilities/
  TerminalCapability.tsx
  terminalCapabilityDescriptor.ts
```

Feature folders own capability implementations. The app-level registry imports
small public descriptors from those feature folders.

Example registry entry:

```text
id: terminal
name: Terminal
owning feature: terminal
required context: session id, working directory
render modes: bottomDock, floating, rightRail
states: unavailable, starting, running, exited, error
primary actions: open, collapse, expand, add tab, select tab, restart, stop
```

## One-By-One Refactor Strategy

Do not pause feature work to migrate the whole app into capabilities. Instead,
when a feature request touches a product area, ask whether that product area
should be shaped as a composable capability as part of the work.

Recommended sequence:

1. Name the durable product concept.
2. Identify which code owns the behavior today.
3. Separate reusable product behavior from the current screen layout.
4. Create a capability entry point inside the owning feature folder.
5. Keep the current surface working first.
6. Register the capability descriptor if the contract is clear enough.
7. Add new surfaces or render modes on top of the same capability.

This keeps the migration reversible. If a capability contract is wrong, we adjust
one small boundary. If the registry gets too much responsibility too early, the
whole app pays for the wrong abstraction.

## Ownership Boundaries

### Shared UI

`src/shared/ui` is for design-system primitives and reusable visual building
blocks. These should use the design system tokens and existing component
patterns.

Shared UI should not know about product domains like pull requests, sessions,
providers, agents, terminals, or projects.

Good shared UI:

```text
Button
Tabs
Sheet
Tooltip
EmptyState
StatusBadge primitive
```

Not shared UI:

```text
PullRequestReviewButton
AgentModelPicker
TerminalTabs
GitHubConnectionCard
```

### Features

Feature folders own product behavior for a domain. A feature can expose
capabilities and reusable UI to other features, but the source of truth stays
inside the feature.

For new or actively touched feature areas, prefer this shape:

```text
src/features/<feature-name>/
  api/              side effects and service boundaries
  model/            domain types, state rules, filters, derived status
  hooks/            data loading, mutations, controller hooks
  ui/               reusable feature UI pieces
  capabilities/     behavior bundles and render-mode entry points
  views/            team-authored composed screens and panels
```

This structure is a convention, not a reason to move every existing file
immediately. Add it when it helps the work in front of you.

### Capabilities

A capability should have a visible contract. It should make the reusable product
behavior easier to understand, not harder.

A capability owns:

```text
data needs
product states
actions and side effects
validation and disabled states
render modes
control availability defaults
```

A capability should not own:

```text
the entire app layout
a view's unrelated neighboring panels
global app state unrelated to the capability
visual primitives that belong in shared UI
```

### Views And Surfaces

Views are allowed to be opinionated. They define the arrangement and decide which
capabilities appear together.

Views should not duplicate capability behavior. If two views need the same
product action or state handling, that logic belongs in the feature capability,
model, hook, or API layer.

The ownership rule:

```text
Source feature owns the capability.
Composed view owns the arrangement.
Consuming feature owns its own domain context.
```

## Capability Contract

Before a capability is reused across surfaces or registered globally, answer
these questions:

| Question | Why it matters |
| --- | --- |
| What product concept does it model? | Keeps us from extracting a random chunk of UI. |
| What data/context does it need? | Lets views know what they must provide. |
| What actions can it perform? | Keeps behavior reusable instead of page-specific. |
| What states does it handle? | Prevents every surface from reinventing loading, empty, error, disabled, and permission states. |
| What render modes does it support? | Supports progressive disclosure and density changes. |
| Which controls are optional? | Allows surfaces to hide or disable controls without forking behavior. |
| What owns side effects? | Keeps APIs and mutations out of purely visual components. |
| What should remain view-specific? | Prevents capabilities from absorbing entire screens. |

Example:

```text
Capability: Terminal

Needs:
  session id
  working directory or working directory candidates
  focus return target, if the host surface needs one

States:
  unavailable: no working directory
  starting
  running
  exited
  error
  collapsed
  expanded

Actions:
  open terminal
  collapse / expand
  add tab
  select tab
  restart active tab
  stop and close tab
  run command in existing or new tab

Render modes:
  bottom dock
  floating panel
  right rail tile

Host-owned concerns:
  where the terminal is placed
  how much surrounding layout space it receives
  whether it appears beside chat, under a rail, or over content
```

## Render Modes, Variants, And Control Policies

A capability can share data and actions while rendering differently in each
surface. Use render modes or surface adapters for layout and density:

```text
TerminalBottomDock
TerminalFloatingPanel
TerminalRightRailTile
```

Each adapter should use the same capability contract. The adapter decides visual
density and chrome; it should not invent a separate workflow.

This is similar to design-system variants, but with product behavior included:

```text
Design-system component:
  same visual primitive, different variants

Composable capability:
  same product behavior, different render modes and available controls
```

For optional controls, prefer named render modes plus an explicit control policy
over a long list of unstructured booleans.

Good:

```text
ConversationComposerCapability
  surface: home
  controls:
    modelPicker: visible
    projectPicker: visible
    attachments: enabled
```

Avoid:

```text
showModelPicker
showProjectPicker
showVoice
showSkills
showAttachments
showReasoning
showContext
showQueue
showStop
...
```

The goal is not to forbid configuration. The goal is to keep product differences
intentional and readable.

## Cross-Feature Composition

A feature can be a puzzle piece inside another feature's view. For example, a
pull request review workspace may combine pull request capabilities with a chat
capability so the user can review a diff beside an agent conversation.

That does not mean the pull request feature owns chat. It means the composed view
uses chat's public capability surface.

Allowed:

```text
pull-requests view imports ChatSurface from the chat feature's public exports
pull-requests view passes PR context into that chat surface
chat feature still owns session, composer, and conversation behavior
```

Avoid:

```text
pull-requests reaches into private chat hooks
pull-requests copies chat session logic
pull-requests mutates chat state through undocumented helpers
```

If a capability is meant to cross feature boundaries, expose it through a small
public entry point rather than importing random internal files.

## Current Pilot: Terminal

The terminal is a good first capability to move toward the registry because the
feature request itself is about flexible placement.

Today the terminal already has terminal-owned API and lifecycle code, but the
chat view still owns too much terminal product behavior: tabs, active tab,
expanded/collapsed state, tab chrome, bottom-dock layout, shortcuts, and command
routing.

Target direction:

```text
src/features/terminal/
  api/
    terminal.ts
  lib/
    terminalSessionManager.ts
    terminalState.ts
  ui/
    TerminalPanel.tsx
    TerminalTabsHeader.tsx
  capabilities/
    TerminalCapability.tsx
    terminalCapabilityDescriptor.ts

src/app/capabilities/
  registry.ts
  types.ts
```

The first terminal refactor should preserve the existing bottom dock, then make
new placements possible through the same capability contract:

```text
bottom dock first
floating panel next
right rail / bento placement after the behavior boundary is stable
```

This avoids making "floating terminal" a one-off overlay bolted onto `ChatView`.
The product primitive becomes "Terminal," and placement becomes a host
concern.

## Future Example: Conversation Composer

The conversation composer is another strong future capability candidate because
it appears in multiple surfaces with overlapping behavior:

```text
Home composer
Main chat composer
Agent builder composer
```

Those can be one capability with multiple render modes:

```text
ConversationComposerCapability
  render mode: home
  render mode: chatFooter
  render mode: agentBuilder
```

Some controls may be present in one render mode and absent in another. That is
allowed when it is represented as an intentional control policy rather than a
forked implementation.

For example, if a future Home composer removed model selection, it should still
use the same composer capability:

```text
surface: home
controls:
  modelPicker: hidden
```

The visual surface changes. The underlying composer rules do not fork.

## Design System Rules

Capabilities still use the design system. Feature-owned UI does not mean
feature-owned visual language.

Rules:

1. Use existing shared UI primitives before creating new ones.
2. Use semantic tokens and Berd extension tokens from the design system.
3. Do not add one-off colors, spacing systems, shadows, or interaction patterns
   inside a feature.
4. If a capability needs a new reusable visual treatment, propose it as a design
   system primitive or token.
5. Keep density choices surface-specific. A pro workspace can be denser than a
   beginner card, but both should still feel like Berd.

## How To Decide If Something Should Become A Capability

When a future feature request arrives, use this decision test before coding.

Strong candidate for a capability:

1. The same product behavior is needed in more than one view or likely surface.
2. A screen is becoming a bundle of unrelated responsibilities.
3. The feature needs multiple render densities or placements.
4. Logic is being copied between pages, panels, chat, home, or agent-builder.
5. The behavior has meaningful product states beyond simple visual display.
6. A future user-composed workspace would reasonably want this product unit.
7. The feature request is about moving, docking, reusing, or reconfiguring a tool.
8. The product concept can be named clearly without referencing its current
   screen location.

Probably not a capability yet:

1. The behavior is only used once and is still changing quickly.
2. The only reuse is visual styling; that belongs in shared UI.
3. The proposed abstraction would hide important product states.
4. The contract is speculative and not grounded in a real surface need.
5. The extracted unit cannot be named as a durable product concept.
6. The work would require a broad rewrite unrelated to the feature request.

Useful question:

```text
If this surface moved tomorrow, what behavior should move with it?
```

That movable behavior is probably the capability. The layout around it is
probably the view or host surface.

## Migration Guidance

Use this pattern for new work first. Existing screens should move incrementally:

1. When touching a screen, name which parts are view composition and which parts
   are reusable capabilities.
2. Move duplicated product logic into the feature model, hooks, API, or
   capability layer.
3. Keep visual primitives in shared UI.
4. Preserve the existing surface before adding new render modes.
5. Register the capability when its contract is clear enough to describe.
6. Avoid large rewrites whose only goal is matching this folder shape.
7. Let real feature pressure drive extraction.

This keeps the architecture practical. We do not need every feature to become a
capability immediately, and we do not need the registry to become a global
capability store.

## Checklist For Capability-Oriented Feature Work

Before building or refactoring a composed workflow, answer:

1. What durable product concept are we modeling?
2. Is this a feature-owned capability, a shared UI primitive, or just a view
   detail?
3. Which feature folder owns the source of truth?
4. What context does the capability need from its host view?
5. Which actions and side effects does the capability own?
6. What states must be explicit: loading, empty, error, disabled, permission,
   offline, slow, stale, optimistic, or retry?
7. What render mode is needed now?
8. Which render modes are likely soon, but should not be built yet?
9. Which controls are optional by surface?
10. What should stay view-specific?
11. Does this need a registry descriptor now, or can it remain a local capability
    until the contract is clearer?

## Future Direction

The near-term goal is team-authored composition: make Berd easier for the team
to build flexible surfaces without duplicating behavior.

The medium-term goal is a stable global capability registry that can power
internal layout systems, bento surfaces, and reusable workspace composition.

A future user-authored view builder may use the same registry, but the registry
should emerge from real capabilities and real product surfaces rather than from a
speculative plugin architecture.

Each registered capability should eventually have stable metadata:

```text
id
name
description
owning feature
required context
available render modes
optional controls
actions
state contract
connection or permission requirements
```

Keep the registry boring until the product needs more. The important work is the
one-by-one refactor: turn product behavior into clear, reusable capabilities as
we touch the features that need to become flexible.
