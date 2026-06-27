# Conversation Anatomy Plan

## Purpose

Create a designer-readable source of truth for the agent conversation UI: what can appear in the conversation, what it looks like, where its data comes from, which component renders it, and what states it can enter.

This should live in the dev-only design system as a visual, fixture-driven documentation surface. The goal is not only to document individual components, but to map the full conversation experience as a system.

## Why this matters

Agent conversations are not simple chat threads. They are event timelines made up of user messages, assistant responses, tool calls, tool results, file edits, artifacts, approvals, errors, and status transitions.

A good conversation UI reference should help design and engineering answer:

- What UI elements can appear in the conversation?
- What data causes each element to appear?
- Which component owns the rendering?
- What states does each element support?
- What happens while the agent is streaming, working, waiting, errored, or complete?
- Which details are primary user-facing content vs secondary/debug/task detail?
- What should be collapsed, expanded, summarized, or emphasized?

## Recommended artifact

Build a dev-only design-system section called something like:

> **Conversation UI / Anatomy**

This section should combine:

1. Full sample conversations
2. A catalog of message and timeline item types
3. Execution state examples
4. A data ingress map
5. Open UX questions and design decisions

The result should be useful for design review, engineering implementation, QA, and future refactors.

## Core concept: conversation as a timeline

Document the conversation as a sequence of moments, not only as isolated components.

Example lifecycle:

```text
User asks a question
  ↓
Agent starts working
  ↓
Assistant streams text
  ↓
Agent invokes a tool
  ↓
Tool returns a result
  ↓
Agent edits or references files
  ↓
Agent summarizes progress
  ↓
Conversation completes, errors, waits, or is cancelled
```

This framing helps expose UX decisions around hierarchy, trust, progress, scannability, and recovery.

## Conversation Anatomy page structure

### 1. Full sample conversations

Show realistic end-to-end examples rendered with real app components and static fixtures.

Suggested scenarios:

- Basic user/assistant chat
- Long assistant answer
- Streaming assistant response
- Multi-step agent task
- Tool call success
- Tool call error
- Terminal command output
- File edit or diff flow
- Artifact/image preview
- Approval or permission-required moment
- Cancelled run
- Failed run with retry affordance
- Empty conversation
- Reconnecting or degraded state

These should be stable examples that do not require a live agent session.

### 2. Message and timeline item catalog

Create a visual catalog of everything that can appear in the conversation.

Potential item types:

- User message
- Assistant message
- Streaming assistant message
- System/status message
- Tool call block
- Tool result block
- Terminal output block
- File edit block
- Diff preview
- Artifact preview
- Image/media preview
- Error message
- Permission/approval prompt
- Retry/cancel/stop controls
- Session metadata
- Model or provider metadata
- Composer states

For each item, document:

| Field | Description |
| --- | --- |
| UI element | Human-readable name of the thing shown |
| Visual | Rendered example or screenshot |
| Source data | Backend/ACP/session event or normalized frontend data that creates it |
| Required fields | Minimal data needed to render it correctly |
| States | Loading, streaming, complete, error, collapsed, expanded, etc. |
| Component | React component or rendering path |
| UX notes | Hierarchy, copy, collapse rules, edge cases, open questions |

### 3. Execution states

Document the broader states of the conversation and agent run.

Suggested states:

- Idle
- User composing
- Submitted/queued
- Agent starting
- Assistant streaming text
- Tool running
- Tool succeeded
- Tool failed
- Waiting for user approval
- Waiting for external process
- Cancelled
- Retrying
- Failed
- Completed
- Reconnecting
- Session unavailable

For each state, show:

- What the user sees
- Which controls are available
- Whether the composer is enabled
- Whether progress/status appears
- Whether timeline items are still updating
- How the user can recover or continue

### 4. Data ingress map

Map the path from backend/session data to visible UI.

High-level shape:

```text
Backend / ACP event stream
  ↓
SDK or client transport
  ↓
Event normalization / session state
  ↓
Conversation or transcript model
  ↓
Timeline renderer
  ↓
Message, tool, artifact, error, and composer components
```

For individual elements, document mappings in a table:

| Source event/data | Normalized shape | UI element | Component | Notes |
| --- | --- | --- | --- | --- |
| Assistant text delta | Assistant message content | Streaming assistant message | TBD | Appends while run is active |
| Tool call start | Tool invocation item | Tool call block | TBD | May render collapsed by default |
| Tool result | Tool result item | Tool result block | TBD | Success/error variants |
| Artifact reference | Artifact metadata/path | Artifact preview | TBD | May require local file conversion |
| Error event | Error object/message | Error block | TBD | Needs recovery affordance |

The exact field names should be filled in after auditing the current code.

### 5. Open UX questions

Use the design-system page as a place to capture decisions that affect the conversation experience.

Examples:

- Which tool calls should be visible by default?
- What should collapse automatically after completion?
- How much technical detail should a non-technical user see?
- How do we distinguish agent progress from final answer content?
- What is the right visual hierarchy between text, tools, files, and artifacts?
- How should errors explain what happened and what the user can do next?
- When should timestamps, model names, or session metadata appear?
- How do we represent uncertainty, partial success, or interrupted work?
- What should be preserved in the transcript after a run completes?

## Fixture-driven design-system strategy

Use static fixtures to render real conversation components without needing live agent sessions.

Benefits:

- Stable visual references
- Fast design iteration
- Easier visual QA
- Better regression coverage
- Shared language between design and engineering
- Safer refactors because UI variants are visible in one place

Recommended fixture organization:

```text
conversation-fixtures/
  basic-chat.ts
  long-answer.ts
  streaming.ts
  tool-success.ts
  tool-error.ts
  file-edit.ts
  terminal-output.ts
  artifact-preview.ts
  approval-required.ts
  cancelled.ts
  failed-run.ts
  empty.ts
```

Each fixture should represent normalized frontend data if possible, not raw backend payloads. If raw backend events are also useful, document both the raw source and normalized shape.

## Implementation plan

### Phase 1: Audit the existing system

- Find the current conversation, transcript, message, composer, tool, artifact, and error components.
- Identify every UI variant already supported.
- Trace where session/message/tool/artifact data enters the frontend.
- Note any places where raw backend data is rendered directly vs normalized first.

### Phase 2: Define the taxonomy

- Create a designer-readable list of conversation item types.
- Group them by user-facing purpose:
  - Human messages
  - Agent response content
  - Agent work/progress
  - Tool and system detail
  - Files/artifacts
  - Errors/recovery
  - Composer/input states
- Identify required fields and states for each type.

### Phase 3: Build fixtures

- Create static examples for the most important conversation scenarios.
- Prefer realistic content over placeholder text.
- Include edge cases like long content, missing data, failed tools, cancelled runs, and partial results.

### Phase 4: Add design-system pages

- Add a top-level Conversation UI / Anatomy page.
- Render full sample conversations from fixtures.
- Add a visual catalog of item types.
- Add data ingress tables beside or below the visuals.
- Include open UX questions directly on the page.

### Phase 5: Validate and maintain

- Use the page during design review and engineering review.
- Add a new fixture whenever a new conversation UI state is introduced.
- Use the page as a visual regression target if the project has screenshot testing.
- Keep the data ingress map updated when session or transcript data flow changes.

## Success criteria

This work is successful when a designer or engineer can open the dev-only design system and answer:

- What can appear in a conversation?
- What does each state look like?
- Where does the data come from?
- Which component renders it?
- What are the known UX decisions or unresolved questions?
- How do we safely evaluate changes to the conversation UI?

## First recommended build

Start with a single page:

> **Conversation UI / Anatomy**

Include these sections first:

1. One realistic full conversation fixture
2. A catalog of user message, assistant message, tool call, tool result, artifact, and error states
3. A simple data ingress diagram
4. A table mapping source data to UI elements
5. A short list of open UX questions

This gives immediate value without requiring the entire system to be documented upfront.
