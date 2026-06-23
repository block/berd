# Chat Scroll Mode State Machine Proposal

_Date: 2026-06-22_

## Feature Intent

Chat streaming should feel stable and predictable:

- When the user has not touched the transcript, new assistant content should keep the transcript attached to the latest content so the user can read as it streams.
- When the user scrolls up, the transcript should detach and stop pulling them back down.
- When the user manually scrolls back down to the latest content, the transcript should reattach and behave exactly like it did before they detached.
- Clicking **Jump to latest** and manually scrolling to the bottom should land in the same attached/following state.
- When a streaming response completes, the transcript should not jump up or down unexpectedly.

This proposal is about making the scroll behavior easier to reason about, not changing the visual design of the chat transcript.

## Current System

The virtual chat timeline currently coordinates scroll behavior through several overlapping refs and pieces of state in `src/features/chat/ui/VirtualMessageTimeline.tsx`:

- `scrollIntentRef`
- `userDetachedRef`
- `userDetached` React state
- `detachedScrollTopRef`
- `streamingBottomFollowActiveRef`
- `suppressFollowResumeFromProgrammaticScrollRef`
- `stickyScrollUntilRef`
- `lastScrollTopRef`
- `userScrollIntentRef`
- `userScrollDirectionRef`

Each flag is useful locally, but together they approximate one product concept: **who owns the scroll position right now?**

Because the ownership model is implicit, different paths can reach slightly different states:

- Normal streaming follow uses one path.
- Manual scrolling to bottom uses inferred wheel/scroll intent.
- **Jump to latest** uses an explicit button path.
- Virtual live-tail handoff uses another path when streaming content moves back into virtualized history.
- Resize and measurement reconciliation can also write `scrollTop`.

That makes the behavior prone to races where programmatic scroll movement is interpreted as user intent, or where the UI appears visually attached while an internal detached flag remains true.

## Problem Observed

During debugging on 2026-06-22, the following issues came up:

1. **Completion jump while attached**  
   The transcript could jump when the assistant finished responding because layout changed at completion.

2. **Detached completion handoff**  
   When a live streaming tail moved back into virtualized history, scroll position could be corrected in a way that read as a jump.

3. **Manual reattach is unreliable**  
   Clicking **Jump to latest** reliably reattaches, but manually scrolling to the bottom can fail to restore the same following behavior.

4. **Programmatic follow can look like user intent**  
   The streaming follow loop writes `scrollTop` while content grows. The resulting scroll event can be interpreted as user scrolling, which can detach the user again.

These are symptoms of the same architectural issue: scroll ownership is distributed across several flags instead of represented as one explicit mode.

## Proposed Model

Introduce one explicit scroll ownership model for the chat timeline.

```ts
type ChatScrollMode =
  | { kind: "following" }
  | { kind: "detached"; anchorScrollTop: number }
  | { kind: "jumping-to-latest" }
  | { kind: "targeting-message"; messageId: string };
```

The mode answers one question:

> Who owns the transcript scroll position right now?

### Mode Definitions

#### `following`

The transcript is attached to the latest content.

Behavior:

- Streaming assistant content may move the viewport downward.
- New content should keep the user at or near the latest content.
- **Jump to latest** should be hidden.
- User scroll away from latest transitions to `detached`.

#### `detached`

The user has intentionally left the latest content.

Behavior:

- Streaming assistant content must not pull the viewport downward.
- **Jump to latest** may be shown when there is real content below the viewport.
- Manual scroll to pinned/latest transitions to `following`.
- Clicking **Jump to latest** transitions to `jumping-to-latest`.

#### `jumping-to-latest`

The app is programmatically moving the viewport to the latest content.

Behavior:

- Programmatic scroll owns the viewport.
- User input can interrupt and return to `detached`.
- Streaming follow should not fight the jump animation.
- Once pinned/latest is confirmed, transition to `following`.

#### `targeting-message`

The app is navigating to a specific transcript message, for example from search or a response-start affordance.

Behavior:

- Target navigation owns the viewport.
- Streaming follow should not interfere.
- When target resolution finishes, derive the next mode from position:
  - pinned/latest -> `following`
  - otherwise -> `detached`

## State Transitions

```text
following
  ├─ user scrolls away from latest ───────────────▶ detached
  ├─ target message requested ───────────────────▶ targeting-message
  └─ session/message reset at latest ────────────▶ following


detached
  ├─ user manually reaches pinned latest ────────▶ following
  ├─ Jump to latest clicked ─────────────────────▶ jumping-to-latest
  ├─ target message requested ───────────────────▶ targeting-message
  └─ stream completes while detached ────────────▶ detached


jumping-to-latest
  ├─ pinned latest confirmed ────────────────────▶ following
  ├─ user interrupts upward/away ────────────────▶ detached
  └─ target message requested ───────────────────▶ targeting-message


targeting-message
  ├─ target resolved and pinned latest ──────────▶ following
  ├─ target resolved away from latest ───────────▶ detached
  └─ user interrupts ────────────────────────────▶ detached
```

## Core Rules

### 1. Pinned latest is the canonical attach condition

Manual reattach and **Jump to latest** should converge through the same condition:

```text
confirmed pinned/latest -> mode = following
```

Manual scrolling should not need a separate heuristic path that differs from the button path.

### 2. Programmatic scrolls must not detach the user

When the app writes `scrollTop`, the resulting scroll event should not be treated as user intent.

Examples of programmatic scroll writes:

- streaming bottom-follow
- jump-to-latest animation
- scroll-to-message/search target
- virtual controller anchor correction
- resize reconciliation

These should update geometry, not change scroll ownership unless the owning operation explicitly transitions mode.

### 3. User intent should be directional

User input should be recorded as a product-level intent:

```ts
type UserScrollDirection = "toward-latest" | "away-from-latest";
```

- Wheel/touch/key input toward latest can reattach if the viewport reaches latest.
- Wheel/touch/key input away from latest can detach.
- Raw `scrollTop` deltas should be fallback evidence, not the main source of truth.

### 4. Streaming follow only runs in `following`

The streaming follow loop should be gated by mode:

```text
if mode.kind !== "following": do not stream-follow
```

This prevents detached users and target navigation from being pulled around.

### 5. Live-tail completion preserves mode

When a live streaming tail is promoted back into virtualized history:

- If mode is `following`, keep the viewport pinned to latest.
- If mode is `detached`, preserve the detached position/anchor.
- Do not infer a new mode from intermediate virtual measurements unless the user actually reattached.

## Suggested Implementation Plan

### Phase 1: Introduce a local scroll mode helper

Add a small local reducer/helper near `VirtualMessageTimeline` first. Avoid a broad architectural migration until behavior is verified.

Possible shape:

```ts
type ChatScrollMode =
  | { kind: "following" }
  | { kind: "detached"; anchorScrollTop: number }
  | { kind: "jumping-to-latest" }
  | { kind: "targeting-message"; messageId: string };

function isFollowing(mode: ChatScrollMode): boolean {
  return mode.kind === "following";
}

function isDetached(mode: ChatScrollMode): boolean {
  return mode.kind === "detached";
}
```

Keep the mode in a ref because scroll decisions happen inside layout effects and animation frames:

```ts
const scrollModeRef = useRef<ChatScrollMode>({ kind: "following" });
```

If React render state is needed for UI, mirror only the minimum derived values:

```ts
const [showJumpToLatest, setShowJumpToLatest] = useState(false);
```

### Phase 2: Centralize transitions

Replace direct scattered writes to `userDetachedRef`, `scrollIntentRef`, and related flags with named transition functions:

```ts
function attachToLatest(reason: string): void;
function detachFromLatest(reason: string, anchorScrollTop: number): void;
function startJumpToLatest(): void;
function finishJumpToLatest(): void;
function startTargetingMessage(messageId: string): void;
function finishTargetingMessage(): void;
```

Each transition should own all side effects for that mode change:

- update `scrollModeRef`
- update `showJumpToLatest`
- stop/start streaming follow if needed
- clear stale live-tail handoff state if needed
- sync virtual viewport if needed

### Phase 3: Make scroll event handling mode-driven

`syncScrollState` should become a small mode switch:

```text
if mode = following:
  if user intentionally moved away -> detached
  else remain following

if mode = detached:
  if pinned latest -> following
  else remain detached

if mode = jumping-to-latest:
  if pinned latest -> following
  else do not detach unless user interrupts

if mode = targeting-message:
  do not follow latest until targeting completes
```

This avoids asking every scroll event to reconstruct intent from many flags.

### Phase 4: Align Jump to latest and manual reattach

Currently, **Jump to latest** behaves more reliably because it explicitly reattaches. Manual scrolling relies on inferred heuristics.

After this change:

- **Jump to latest** enters `jumping-to-latest`.
- Manual scroll continues in `detached` until pinned/latest is observed.
- Both paths call `attachToLatest()` only after pinned/latest is confirmed.

### Phase 5: Remove or narrow legacy flags

Once the mode helper owns behavior, remove or reduce these flags:

- `scrollIntentRef`
- `userDetachedRef`
- `userDetached` where possible
- `detachedScrollTopRef`
- `suppressFollowResumeFromProgrammaticScrollRef`
- broad `scrollDeltaDetached` heuristics

Some may remain temporarily as compatibility mirrors, but the goal should be one source of truth.

## Testing Plan

### Unit tests

Add focused tests for the mode helper/reducer:

- `following` + user scroll away -> `detached`
- `detached` + pinned latest -> `following`
- `detached` + near but not pinned latest -> stays `detached`
- `jumping-to-latest` + pinned latest -> `following`
- `jumping-to-latest` + user scroll away -> `detached`
- `targeting-message` + target resolved away from latest -> `detached`

### Timeline integration tests

Add or update `VirtualMessageTimeline` tests for:

1. Untouched streaming follows latest.
2. User scroll up detaches and reveals **Jump to latest**.
3. Detached user is not pulled down by streamed content.
4. Manual scroll to bottom reattaches and follows later streamed content.
5. **Jump to latest** while streaming lands in the same state as manual reattach.
6. Streaming completion while attached does not jump.
7. Streaming completion while detached preserves detached position.
8. Search/target-message navigation does not accidentally reattach.

### Manual QA

Use long streaming responses and test:

- Start at latest and do nothing.
- Scroll up while streaming.
- Scroll back down manually until latest is reached.
- Repeat detach/reattach multiple times in one response.
- Click **Jump to latest** while streaming.
- Let the response finish while attached.
- Let the response finish while detached.
- Resize the window during streaming.

## Success Criteria

This change is successful when:

- Manual reattach and **Jump to latest** behave the same once latest is reached.
- Programmatic scroll writes do not cause detach transitions.
- Detached users stay detached through streaming and completion.
- Attached users stay attached through streaming and completion.
- The code has one inspectable scroll ownership model instead of several competing flags.

## Non-goals

- Rewriting transcript virtualization.
- Changing transcript visual layout.
- Changing search behavior beyond making targeting state explicit.
- Removing all legacy flags in one risky PR if a phased migration is safer.

## Open Questions

1. Should `near latest` be enough to reattach during streaming, or should only `pinned latest` reattach?  
   Recommendation: use `pinned latest` for final attach, but allow near-latest to trigger a controlled catch-up scroll while still in `detached` or `reattaching` if that feels better.

2. Should `jumping-to-latest` animate during streaming?  
   Recommendation: instant jump during streaming, smooth jump when not streaming. Streaming bottom is a moving target, so animation can introduce races.

3. Should `targeting-message` be represented in the first refactor?  
   Recommendation: include the mode in the type, but migrate target navigation after following/detached/jumping behavior is stable.

## Recommended First PR

The first implementation PR should focus only on the core stream behavior:

- Introduce `ChatScrollMode`.
- Migrate following/detached/jumping-to-latest.
- Leave `targeting-message` mostly as a compatibility path if needed.
- Add tests for manual reattach and completion behavior.

A later cleanup PR can remove old compatibility refs and fold targeting/search into the same model.
