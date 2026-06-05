# Composable Capabilities

Date: 2026-06-05

## Summary

Goose should support both beginners and pro engineers without forcing every
workflow into a separate hard-coded screen. The codebase should make product
surfaces composable: a team-authored view can combine reusable feature pieces
today, and a future user-authored view builder can reuse the same pieces later.

The architecture goal is:

```text
design-system primitives
down to
feature capabilities
down to
composed product views
```

The core rule:

```text
Views compose capabilities.
Capabilities own product behavior.
Shared UI owns visual primitives.
APIs own side effects.
```

This is not a rewrite plan. It is a convention for new feature work and a guide
for gradually untangling existing screens when we touch them.

## Vocabulary

| Term | Meaning | Example |
| --- | --- | --- |
| Component | Mostly visual UI. It should not own product workflow logic. | Button, dialog, tabs, empty state, status chip |
| Capability | A reusable product unit that bundles data needs, actions, states, and render modes. | Pull request summary, pull request diff, conversation composer |
| View | A composed screen, panel, or workflow surface made from capabilities. | PR inbox, project chat, first PR created moment |
| Surface | A place where a capability can appear with a specific density and layout. | Inline chat, right rail, full page, compact row |
| API | The boundary that talks to Tauri, ACP, GitHub, local storage, or external services. | Fetch PRs, start a session, submit a review |
| Model | Product rules and state definitions that are not tied to a visual layout. | PR status rules, filters, loading/error states |

The important distinction: a capability is not just a bigger component. It owns
enough behavior to work correctly wherever it is rendered.

## Why This Matters

Goose's product vision is progressive disclosure. A beginner may only need to
see that their first pull request was created, plus a short summary and a clear
next action. A pro engineer may need a review queue, status, diff, comments,
actions, filters, and agent help in one dense workspace.

Those should not become two unrelated implementations.

Instead, the same pull request capabilities should support both experiences:

```text
Beginner view:
  PullRequestSummary, compact
  OpenPullRequestAction
  Diff hidden unless requested

Pro view:
  PullRequestQueue
  PullRequestSummary
  PullRequestDiff
  PullRequestActions
  SavedFilters
```

The product team can compose the first set of views. Later, users can compose
their own views from the same capability contracts if that product direction
proves useful.

## Ownership Boundaries

### Shared UI

`src/shared/ui` is for design-system primitives and reusable visual building
blocks. These should use the design system tokens and existing component
patterns.

Shared UI should not know about product domains like pull requests, sessions,
providers, agents, or projects.

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
SessionTerminalTabs
GitHubConnectionCard
```

### Features

Feature folders own product behavior for a domain. A feature can expose
capabilities and reusable UI to other features, but the source of truth stays
inside the feature.

For new feature areas, use this shape:

```text
src/features/<feature-name>/
  api/              side effects and service boundaries
  model/            domain types, state rules, filters, derived status
  hooks/            data loading, mutations, controller hooks
  ui/               reusable feature UI pieces
  capabilities/     behavior bundles and render-mode entry points
  views/            team-authored composed screens and panels
```

This structure is a convention, not a requirement to move every existing feature
immediately.

### Cross-Feature Composition

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

The ownership rule:

```text
Source feature owns the capability.
Composed view owns the arrangement.
Consuming feature owns its own domain context.
```

This means a feature can be reused inside another feature without being absorbed
by it. If a capability is meant to cross feature boundaries, expose it through a
small public entry point rather than importing random internal files.

Example shape:

```text
src/features/chat/
  capabilities/
  ui/
  model/
  index.ts          public exports for other features

src/features/pull-requests/views/
  PullRequestReviewWorkspace
    uses PullRequestDiff from pull-requests
    uses PullRequestActions from pull-requests
    uses ChatSurface from chat
```

### Views

Views are allowed to be opinionated. They define the layout and decide which
capabilities appear together.

Views should not duplicate capability behavior. If two views need the same
product action or state handling, that logic belongs in the feature capability
or model layer.

## Capability Contract

A capability should make its contract visible. Before it is reused across
surfaces, it should answer these questions:

| Question | Why it matters |
| --- | --- |
| What data does it need? | Lets views know what context they must provide. |
| What actions can it perform? | Keeps behavior reusable instead of page-specific. |
| What states does it handle? | Prevents every surface from reinventing loading, empty, error, and permission states. |
| What surfaces can it render into? | Supports progressive disclosure and density changes. |
| What permissions or connections does it require? | Makes blocked states explicit. |
| What owns side effects? | Keeps APIs and mutations out of purely visual components. |

Example:

```text
Capability: Pull Request Summary

Needs:
  repository
  pull request id or pull request object
  GitHub connection state

States:
  loading
  ready
  not connected
  missing permission
  not found
  error

Actions:
  open pull request
  copy link
  ask agent to summarize

Render modes:
  inline in chat
  compact row in inbox
  card in context panel
  header in detail view
```

## Render Modes And Surface Adapters

A capability can share data and actions while rendering differently in each
surface. Use small surface adapters for layout and density:

```text
PullRequestSummaryInline
PullRequestSummaryRow
PullRequestSummaryCard
PullRequestSummaryPanel
```

Each adapter should use the same capability contract. The adapter decides visual
density; it should not invent a separate workflow.

This keeps a future user-composed view from needing to know implementation
details. It only needs to know that "Pull Request Summary" can render in a row,
card, inline, or panel form.

## Do Not Add A Global Registry Yet

A global capability registry may eventually be useful for user-authored views,
but it is too early to make it the foundation. Start with static composition:

```text
PullRequestInboxView imports the PR capabilities it needs.
Chat can import the PR summary inline renderer when a PR is attached.
Home can import a compact PR status card if that becomes useful.
```

After several capabilities exist and the repeated contract is proven, a registry
can emerge from real usage rather than guesses.

## Pilot: Pull Request Workflows

Pull request work is a strong pilot because it naturally spans beginner and pro
needs.

Beginner moments:

```text
User creates their first PR.
Goose shows a readable summary.
Goose gives a simple open/share action.
Diff and review tools stay available but not prominent.
```

Pro workflow:

```text
User opens a PR inbox.
Goose shows review queue, status, diffs, comments, actions, and filters.
Chat can sit beside the PR context and help with review or summary.
```

Recommended first implementation sequence:

1. Add the pull-request feature folder when PR work begins.
2. Build the domain API and model first: list, detail, diff, review actions,
   connection state, loading, empty, error, permission states.
3. Build small render modes: status, list row, summary, diff panel, action bar.
4. Compose an internal `PullRequestInboxView`.
5. Reuse the same summary and diff capability inside chat when the user asks for
   PR context.
6. Only later consider user-authored view composition.

## Chat As A Capability Family

Chat is currently one of the places where composition pressure is visible. A
full chat view needs conversation, composer, session control, context panels,
terminal behavior, and sometimes agent-builder behavior.

Do not move a giant `ChatView` into shared UI. Instead, gradually separate chat
into capability-sized pieces when related work touches it:

```text
ConversationTimeline
Composer
SessionController
ContextRail
TerminalSurface
ChatSurface
```

That lets Goose reuse chat in a full screen, beside a PR, inside a project, or
inside a focused workflow without dragging every full-screen concern into each
surface.

## Design System Rules

Capabilities still use the design system. Feature-owned UI does not mean
feature-owned visual language.

Rules:

1. Use existing shared UI primitives before creating new ones.
2. Use semantic tokens and Goose extension tokens from the design system.
3. Do not add one-off colors, spacing systems, shadows, or interaction patterns
   inside a feature.
4. If a capability needs a new reusable visual treatment, propose it as a design
   system primitive or token.
5. Keep density choices surface-specific. A pro inbox can be denser than a
   beginner card, but both should still feel like Goose.

## When To Extract A Capability

Do extract a capability when:

1. The same product behavior is needed in more than one view.
2. A screen is becoming a bundle of unrelated responsibilities.
3. A feature needs multiple render densities for beginner and pro experiences.
4. Logic is being copied between pages, panels, and chat.
5. A future user-composed view would reasonably want this product unit.

Do not extract a capability when:

1. The behavior is only used once and still changing quickly.
2. The only reuse is visual styling; that probably belongs in shared UI.
3. The abstraction would hide important product states.
4. The contract is speculative and not yet proven by real views.

## Migration Guidance

Use this pattern for new work first. Existing screens should move incrementally:

1. When touching a screen, name which parts are view composition and which parts
   are reusable capabilities.
2. Move duplicated product logic into the feature model, hooks, or capability
   layer.
3. Keep visual primitives in shared UI.
4. Avoid large rewrites whose only goal is matching this folder shape.
5. Let proven reuse drive extraction.

This keeps the architecture reversible. If a capability is wrong, we can adjust a
small contract. If a global registry is added too soon, the whole app has to pay
for the wrong abstraction.

## Checklist For New Feature Work

Before building a new composed workflow, answer:

1. What capabilities does this view need?
2. Which capability owns each data fetch or mutation?
3. What render modes are needed now?
4. Which render modes are likely soon, but should not be built yet?
5. What loading, empty, error, permission, offline, and slow states exist?
6. What design-system primitives or tokens are needed?
7. What should stay view-specific?
8. What should be easy to reuse from chat, home, projects, or another future
   surface?

## Future Direction

If team-authored composed views prove useful, Goose can later add a lightweight
capability registry for user-authored views. At that point, each registered
capability would need stable metadata:

```text
name
description
required context
available render modes
connection requirements
actions
state contract
```

That should come after several real capabilities exist. The near-term goal is to
make Goose easier for the team to compose without overbuilding the future view
builder.
