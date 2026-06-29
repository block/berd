# Chat Completion Notifications — Design Spec

**Date:** 2026-06-03
**Branch:** chai/desktop-notifs
**Status:** Approved

## Problem

When Berd is minimized or the user is viewing a different chat session, there is no signal that an agent has finished generating. Users must actively check back. The open-source Goose desktop app already has this feature; internal users expect parity.

## Scope

- Fire an OS-level notification when the window is not focused and any chat session finishes.
- Fire an in-app toast when the window is focused but the user is viewing a different session than the one that finished.
- No notification fires when the user is already watching the session that finishes (streaming is visible).
- Notifications fire for all terminal outcomes: success, error, and user-initiated abort.
- User can configure notification behavior via a dedicated Notifications section in Settings.

## Architecture

A single `useCompletionNotifications` hook owns all notification logic. It mounts once inside `AppShell.tsx` and watches all sessions regardless of which one is currently displayed.

The hook has three internal concerns:

1. **Completion detection** — Zustand store subscription, fires when any session transitions to idle.
2. **Window focus tracking** — Tauri `onFocusChanged` listener stored in a ref.
3. **Delivery** — OS notification (unfocused) or sonner toast (focused + different session).

```
AppShell
  └── useCompletionNotifications
        ├── useChatStore.subscribe()      ← watches chatState per session
        ├── getCurrentWindow().onFocusChanged()  ← tracks focus in a ref
        └── on completion:
              if !windowFocused → sendNotification() [tauri-plugin-notification]
              if windowFocused && sessionId !== activeSessionId → toast() [sonner]
```

## Completion Detection

`useCompletionNotifications` subscribes to `useChatStore` via Zustand's `.subscribe(state, prevState)`. It tracks the previous `chatState` per session by comparing `state` and `prevState` on each store change.

A notification fires when a session transitions from `"streaming"` or `"thinking"` to `"idle"` — regardless of whether the outcome was success, error, or user-initiated abort. All three outcomes represent the agent being done and the user potentially needing to act.

States `"waiting"` and `"compacting"` transitioning to `"idle"` do **not** trigger a notification — these represent intermediate states, not a completed agent response.

The notification body reflects the outcome using the last message's `completionStatus`:
- `"completed"` → `"<session title> finished"`
- `"error"` → `"<session title> encountered an error"`
- `"stopped"` (abort) → `"<session title> was stopped"`
- fallback → `"<session title> finished"`

The active session is read from `useChatSessionStore.getState().activeSessionId`. If the completed session matches the active session, no notification fires.

## Notification Delivery

### OS notification (window unfocused)

Uses `tauri-plugin-notification` — the official Tauri 2 cross-platform plugin.

```
Title: "Berd"
Body:  "<session title> finished"              (completionStatus: "completed")
       "<session title> encountered an error"  (completionStatus: "error")
       "<session title> was stopped"           (completionStatus: "stopped")
```
Session title falls back to `"Agent"` if the session has no title yet.

**Required changes to wire up the plugin:**
- `src-tauri/Cargo.toml`: add `tauri-plugin-notification = "2"`
- `src-tauri/src/lib.rs`: register with `.plugin(tauri_plugin_notification::init())`
- `src-tauri/capabilities/default.json`: add `"notification:default"` to the permissions array
- `package.json`: add `"@tauri-apps/plugin-notification": "^2"`

### In-app toast (focused, different session)

Uses `sonner` (already wired in `App.tsx`). Fires `toast()` with outcome-appropriate text matching the OS notification body above, plus an action button **"View"** that navigates to the completed session. Error outcomes use `toast.error()`, others use `toast()`.

Uses sonner's default auto-dismiss timeout (no custom duration).

## User Preferences

### Storage

A single JSON blob in localStorage under key `"berd:notifications"`:

```json
{ "enabled": true, "inApp": true, "desktop": true }
```

All three default to `true`. A small utility function `getNotificationPrefs()` / `setNotificationPrefs()` in `src/features/settings/lib/notificationPrefs.ts` reads and writes this with try-catch (matching the existing localStorage pattern in the app).

The hook reads preferences **synchronously at delivery time** (not reactive state), so toggling a preference takes effect on the next completion without re-mounting the hook.

### Settings UI

A new `NotificationSettings` component (`src/features/settings/ui/NotificationSettings.tsx`) added as a section in the existing Settings page.

Layout:

```
Notifications
  ┌─────────────────────────────────────────┐
  │ Enable notifications          [toggle]  │
  └─────────────────────────────────────────┘
  (when enabled = true, reveal:)
  ┌─────────────────────────────────────────┐
  │ In-app                        [toggle]  │
  │ Show a banner when you're in a          │
  │ different chat session                  │
  └─────────────────────────────────────────┘
  ┌─────────────────────────────────────────┐
  │ Desktop                       [toggle]  │
  │ Send an OS notification when the        │
  │ app is in the background                │
  └─────────────────────────────────────────┘
```

Sub-toggles are only shown when the master `enabled` toggle is on. Toggling the master off hides the sub-toggles (and persists their last values so they're restored when master is turned back on).

### i18n

New translation keys (following existing patterns in `src/features/settings/`):

```
settings:notifications.title
settings:notifications.enabled.label
settings:notifications.inApp.label
settings:notifications.inApp.description
settings:notifications.desktop.label
settings:notifications.desktop.description
```

## File Changes Summary

| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | Add `tauri-plugin-notification = "2"` |
| `src-tauri/src/lib.rs` | Register notification plugin |
| `src-tauri/capabilities/default.json` | Add `notification:default` permission |
| `package.json` | Add `@tauri-apps/plugin-notification` |
| `src/shared/hooks/useCompletionNotifications.ts` | **New** — core hook |
| `src/features/settings/lib/notificationPrefs.ts` | **New** — localStorage read/write utility |
| `src/features/settings/ui/NotificationSettings.tsx` | **New** — settings section component |
| `src/app/AppShell.tsx` | Mount `useCompletionNotifications` |
| `src/features/settings/ui/settingsSections.ts` | Add `"notifications"` entry to `SETTINGS_SECTIONS` |
| `src/features/settings/ui/SettingsView.tsx` | Render `NotificationSettings` for `activeSection === "notifications"` |
| `src/shared/i18n/locales/en/settings.json` | Add notification i18n keys under `"notifications"` key |

## Out of Scope

- Sound configuration (can be added later).
- Per-session notification toggle (global preference only for now).
- Notification history / notification center.
- Automation completion notifications (separate feature, `enableNotifications` field already exists on automation tiles but is not yet wired up).
