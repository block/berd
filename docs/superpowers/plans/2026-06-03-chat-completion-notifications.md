# Chat Completion Notifications — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fire an OS notification (window unfocused) or in-app toast (focused, different session) whenever any chat session finishes generating — for all outcomes: success, error, or abort.

**Architecture:** A single `useCompletionNotifications` hook mounts once in `AppShell`. It subscribes to `useChatStore` to detect session completions, tracks window focus via Tauri's `onFocusChanged`, and fires either `sendNotification` (desktop) or `toast` (in-app) based on focus state and user prefs stored in localStorage.

**Tech Stack:** `tauri-plugin-notification` (new), `sonner` (existing), Zustand store subscription, Tauri `@tauri-apps/api/window`, `vitest` + `@testing-library/react`

**Spec:** `docs/superpowers/specs/2026-06-03-chat-completion-notifications-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src-tauri/Cargo.toml` | Modify | Add `tauri-plugin-notification` dep |
| `src-tauri/src/lib.rs` | Modify | Register notification plugin |
| `src-tauri/capabilities/default.json` | Modify | Add `notification:default` permission |
| `package.json` | Modify | Add `@tauri-apps/plugin-notification` |
| `src/features/settings/lib/notificationPrefs.ts` | Create | localStorage read/write for notification prefs |
| `src/features/settings/lib/__tests__/notificationPrefs.test.ts` | Create | Tests for prefs utility |
| `src/shared/hooks/useCompletionNotifications.ts` | Create | Core hook: completion detection + delivery |
| `src/shared/hooks/__tests__/useCompletionNotifications.test.ts` | Create | Tests for hook helper functions |
| `src/app/AppShell.tsx` | Modify | Mount `useCompletionNotifications` |
| `src/shared/i18n/locales/en/settings.json` | Modify | Add notification i18n keys |
| `src/shared/i18n/locales/es/settings.json` | Modify | Add notification i18n keys (Spanish) |
| `src/features/settings/ui/NotificationSettings.tsx` | Create | Settings section component |
| `src/features/settings/ui/__tests__/NotificationSettings.test.tsx` | Create | Tests for settings component |
| `src/features/settings/ui/settingsSections.ts` | Modify | Add `"notifications"` section entry |
| `src/features/settings/ui/SettingsView.tsx` | Modify | Render `NotificationSettings` |

---

## Task 1: Wire up tauri-plugin-notification

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `package.json`

- [ ] **Step 1: Add Cargo dependency**

In `src-tauri/Cargo.toml`, add after `tauri-plugin-deep-link = "2"`:

```toml
tauri-plugin-notification = "2"
```

- [ ] **Step 2: Register plugin in lib.rs**

In `src-tauri/src/lib.rs`, add `.plugin(tauri_plugin_notification::init())` after `.plugin(tauri_plugin_deep_link::init())`:

```rust
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
```

- [ ] **Step 3: Add capability permission**

In `src-tauri/capabilities/default.json`, add `"notification:default"` to the `"permissions"` array (after `"process:allow-restart"`):

```json
    "process:allow-restart",
    "notification:default"
```

- [ ] **Step 4: Add npm package**

```bash
pnpm add @tauri-apps/plugin-notification
```

- [ ] **Step 5: Verify Rust compiles**

```bash
just tauri-check
```

Expected: exits 0, no errors about `tauri_plugin_notification`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/capabilities/default.json package.json pnpm-lock.yaml
git commit -m "feat: add tauri-plugin-notification"
```

---

## Task 2: Notification preferences utility

**Files:**
- Create: `src/features/settings/lib/notificationPrefs.ts`
- Create: `src/features/settings/lib/__tests__/notificationPrefs.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/features/settings/lib/__tests__/notificationPrefs.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getNotificationPrefs,
  setNotificationPrefs,
} from "../notificationPrefs";

describe("getNotificationPrefs", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns all-true defaults when nothing is stored", () => {
    expect(getNotificationPrefs()).toEqual({
      enabled: true,
      inApp: true,
      desktop: true,
    });
  });

  it("returns stored values merged with defaults", () => {
    localStorage.setItem(
      "berd:notifications",
      JSON.stringify({ enabled: false }),
    );
    expect(getNotificationPrefs()).toEqual({
      enabled: false,
      inApp: true,
      desktop: true,
    });
  });

  it("returns defaults when stored value is invalid JSON", () => {
    localStorage.setItem("berd:notifications", "not-json");
    expect(getNotificationPrefs()).toEqual({
      enabled: true,
      inApp: true,
      desktop: true,
    });
  });

  it("returns defaults when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(getNotificationPrefs()).toEqual({
      enabled: true,
      inApp: true,
      desktop: true,
    });
  });
});

describe("setNotificationPrefs", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("persists a partial update without wiping other keys", () => {
    setNotificationPrefs({ enabled: false });
    expect(getNotificationPrefs()).toEqual({
      enabled: false,
      inApp: true,
      desktop: true,
    });
  });

  it("merges multiple sequential updates", () => {
    setNotificationPrefs({ desktop: false });
    setNotificationPrefs({ inApp: false });
    expect(getNotificationPrefs()).toEqual({
      enabled: true,
      inApp: false,
      desktop: false,
    });
  });

  it("does not throw when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(() => setNotificationPrefs({ enabled: false })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
just test -- src/features/settings/lib/__tests__/notificationPrefs.test.ts
```

Expected: FAIL — module `../notificationPrefs` not found.

- [ ] **Step 3: Implement notificationPrefs.ts**

Create `src/features/settings/lib/notificationPrefs.ts`:

```typescript
const STORAGE_KEY = "berd:notifications";

export interface NotificationPrefs {
  enabled: boolean;
  inApp: boolean;
  desktop: boolean;
}

const DEFAULTS: NotificationPrefs = { enabled: true, inApp: true, desktop: true };

export function getNotificationPrefs(): NotificationPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setNotificationPrefs(prefs: Partial<NotificationPrefs>): void {
  try {
    const current = getNotificationPrefs();
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...current, ...prefs }),
    );
  } catch {
    // localStorage unavailable in some environments
  }
}
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
just test -- src/features/settings/lib/__tests__/notificationPrefs.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/settings/lib/notificationPrefs.ts src/features/settings/lib/__tests__/notificationPrefs.test.ts
git commit -m "feat: add notification prefs localStorage utility"
```

---

## Task 3: useCompletionNotifications hook

**Files:**
- Create: `src/shared/hooks/useCompletionNotifications.ts`
- Create: `src/shared/hooks/__tests__/useCompletionNotifications.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/shared/hooks/__tests__/useCompletionNotifications.test.ts`:

```typescript
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCompletionOutcome,
  getNotificationBody,
} from "../useCompletionNotifications";
import type { Message } from "@/shared/types/messages";

// ── Pure function tests ────────────────────────────────────────────────────

describe("getCompletionOutcome", () => {
  function makeMsg(completionStatus: string): Message {
    return {
      id: "m1",
      role: "assistant",
      created: Date.now(),
      content: [],
      metadata: { userVisible: true, agentVisible: true, completionStatus } as Message["metadata"],
    };
  }

  it("returns 'error' when last assistant message has error status", () => {
    expect(getCompletionOutcome([makeMsg("error")])).toBe("error");
  });

  it("returns 'stopped' when last assistant message has stopped status", () => {
    expect(getCompletionOutcome([makeMsg("stopped")])).toBe("stopped");
  });

  it("returns 'completed' when last assistant message has completed status", () => {
    expect(getCompletionOutcome([makeMsg("completed")])).toBe("completed");
  });

  it("returns 'completed' as fallback for empty messages", () => {
    expect(getCompletionOutcome([])).toBe("completed");
  });

  it("uses the last assistant message when multiple exist", () => {
    expect(
      getCompletionOutcome([makeMsg("completed"), makeMsg("error")]),
    ).toBe("error");
  });
});

describe("getNotificationBody", () => {
  it("builds body for completed outcome", () => {
    expect(getNotificationBody("completed", "My session")).toBe(
      "My session finished",
    );
  });

  it("builds body for error outcome", () => {
    expect(getNotificationBody("error", "My session")).toBe(
      "My session encountered an error",
    );
  });

  it("builds body for stopped outcome", () => {
    expect(getNotificationBody("stopped", "My session")).toBe(
      "My session was stopped",
    );
  });

  it("falls back to 'Agent' when session title is empty", () => {
    expect(getNotificationBody("completed", "")).toBe("Agent finished");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
just test -- src/shared/hooks/__tests__/useCompletionNotifications.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement useCompletionNotifications.ts**

Create `src/shared/hooks/useCompletionNotifications.ts`:

```typescript
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { getNotificationPrefs } from "@/features/settings/lib/notificationPrefs";
import { isDefaultChatTitle } from "@/features/chat/lib/sessionTitle";
import type { ChatState } from "@/shared/types/chat";
import type { Message } from "@/shared/types/messages";

// Sessions that have entered an active (streaming/thinking) state and not yet
// resolved. Tracked as a module-level set so the Zustand subscriber (which
// runs outside React) can read/write it without a closure dependency.
const pendingSessions = new Set<string>();

export function getCompletionOutcome(
  messages: Message[],
): "completed" | "error" | "stopped" {
  for (let i = messages.length - 1; i >= 0; i--) {
    const status = messages[i].metadata?.completionStatus;
    if (status === "error") return "error";
    if (status === "stopped") return "stopped";
    if (status === "completed") return "completed";
  }
  return "completed";
}

export function getNotificationBody(
  outcome: "completed" | "error" | "stopped",
  sessionTitle: string,
): string {
  const name = sessionTitle.trim() || "Agent";
  if (outcome === "error") return `${name} encountered an error`;
  if (outcome === "stopped") return `${name} was stopped`;
  return `${name} finished`;
}

export function useCompletionNotifications(
  onNavigateToSession: (sessionId: string) => void,
): void {
  const windowFocusedRef = useRef(true);
  // Keep a stable ref so the Zustand subscriber never has a stale callback.
  const navigateRef = useRef(onNavigateToSession);
  useEffect(() => {
    navigateRef.current = onNavigateToSession;
  }, [onNavigateToSession]);

  // Track window focus via Tauri's native API.
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    let unlisten: (() => void) | null = null;
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) =>
        getCurrentWindow().onFocusChanged(({ payload: focused }) => {
          windowFocusedRef.current = focused;
        }),
      )
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      unlisten?.();
    };
  }, []);

  // Subscribe to all session state changes and fire notifications on
  // transitions from active → idle. Refs are stable so the dep array is [].
  useEffect(() => {
    return useChatStore.subscribe((state, prevState) => {
      const prefs = getNotificationPrefs();
      if (!prefs.enabled) return;

      for (const sessionId of Object.keys(state.sessionStateById)) {
        const curr = state.sessionStateById[sessionId]?.chatState as
          | ChatState
          | undefined;
        const prev = prevState.sessionStateById[sessionId]?.chatState as
          | ChatState
          | undefined;

        // Track when a session enters an active state.
        if (curr === "streaming" || curr === "thinking") {
          pendingSessions.add(sessionId);
        }

        // Fire when a pending session reaches idle.
        if (curr === "idle" && prev !== "idle" && pendingSessions.has(sessionId)) {
          pendingSessions.delete(sessionId);

          const activeSessionId =
            useChatSessionStore.getState().activeSessionId;
          // Skip if user is already watching this session in a focused window.
          if (sessionId === activeSessionId && windowFocusedRef.current) continue;

          const messages = state.messagesBySession[sessionId] ?? [];
          const outcome = getCompletionOutcome(messages);
          const session = useChatSessionStore.getState().getSession(sessionId);
          // Use the session title only when it's user-set; fall back to empty
          // string so getNotificationBody uses the "Agent" default.
          const title = session && !isDefaultChatTitle(session.title)
            ? session.title
            : "";
          const body = getNotificationBody(outcome, title);

          if (!windowFocusedRef.current) {
            if (!prefs.desktop) continue;
            import("@tauri-apps/plugin-notification").then(
              ({ sendNotification }) => {
                sendNotification({ title: "Berd", body });
              },
            );
          } else {
            if (!prefs.inApp) continue;
            const toastFn = outcome === "error" ? toast.error : toast;
            toastFn(body, {
              action: {
                label: "View",
                onClick: () => navigateRef.current(sessionId),
              },
            });
          }
        }
      }
    });
  }, []);
}
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
just test -- src/shared/hooks/__tests__/useCompletionNotifications.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Run full test suite to check for regressions**

```bash
just test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/shared/hooks/useCompletionNotifications.ts src/shared/hooks/__tests__/useCompletionNotifications.test.ts
git commit -m "feat: add useCompletionNotifications hook"
```

---

## Task 4: Mount hook in AppShell

**Files:**
- Modify: `src/app/AppShell.tsx`

- [ ] **Step 1: Add import**

Near the top of `src/app/AppShell.tsx`, with the other hook imports, add:

```typescript
import { useCompletionNotifications } from "@/shared/hooks/useCompletionNotifications";
```

- [ ] **Step 2: Add navigate callback and mount hook**

In the `AppShell` component body, after the existing `setActiveSession` and `setActiveView` declarations (around line 377–289), add:

```typescript
  const handleNavigateToSession = useCallback(
    (sessionId: string) => {
      setActiveSession(sessionId);
      setActiveView("chat");
    },
    [setActiveSession, setActiveView],
  );

  useCompletionNotifications(handleNavigateToSession);
```

- [ ] **Step 3: Run checks**

```bash
just check
```

Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/app/AppShell.tsx
git commit -m "feat: mount useCompletionNotifications in AppShell"
```

---

## Task 5: Add i18n keys

**Files:**
- Modify: `src/shared/i18n/locales/en/settings.json`
- Modify: `src/shared/i18n/locales/es/settings.json`

- [ ] **Step 1: Add English keys**

In `src/shared/i18n/locales/en/settings.json`, add a top-level `"notifications"` key. Add it after the `"nav"` block:

```json
  "notifications": {
    "title": "Notifications",
    "enabled": {
      "label": "Enable notifications"
    },
    "inApp": {
      "label": "In-app",
      "description": "Show a banner when a chat finishes and you're in a different session."
    },
    "desktop": {
      "label": "Desktop",
      "description": "Send an OS notification when the app is in the background."
    }
  },
```

Also add `"notifications": "Notifications"` to the `"nav"` object:

```json
  "nav": {
    ...existing keys...,
    "notifications": "Notifications"
  },
```

- [ ] **Step 2: Add Spanish keys**

In `src/shared/i18n/locales/es/settings.json`, add the matching Spanish entries. Add `"notifications"` block (after `"nav"`):

```json
  "notifications": {
    "title": "Notificaciones",
    "enabled": {
      "label": "Activar notificaciones"
    },
    "inApp": {
      "label": "En la app",
      "description": "Mostrar un aviso cuando un chat termina y estás en otra sesión."
    },
    "desktop": {
      "label": "Escritorio",
      "description": "Enviar una notificación del sistema cuando la app está en segundo plano."
    }
  },
```

Also add `"notifications": "Notificaciones"` to the Spanish `"nav"` object.

- [ ] **Step 3: Verify i18n check passes**

```bash
just check
```

Expected: exits 0, i18n check passes.

- [ ] **Step 4: Commit**

```bash
git add src/shared/i18n/locales/en/settings.json src/shared/i18n/locales/es/settings.json
git commit -m "feat: add notification i18n keys"
```

---

## Task 6: NotificationSettings component

**Files:**
- Create: `src/features/settings/ui/NotificationSettings.tsx`
- Create: `src/features/settings/ui/__tests__/NotificationSettings.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `src/features/settings/ui/__tests__/NotificationSettings.test.tsx`:

```typescript
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { NotificationSettings } from "../NotificationSettings";
import enSettings from "@/shared/i18n/locales/en/settings.json";

const getPrefs = vi.fn();
const setPrefs = vi.fn();

vi.mock("@/features/settings/lib/notificationPrefs", () => ({
  getNotificationPrefs: (...args: unknown[]) => getPrefs(...args),
  setNotificationPrefs: (...args: unknown[]) => setPrefs(...args),
}));

describe("NotificationSettings", () => {
  beforeEach(() => {
    getPrefs.mockReturnValue({ enabled: true, inApp: true, desktop: true });
    setPrefs.mockClear();
  });

  it("renders the master toggle", () => {
    renderWithProviders(<NotificationSettings />);
    expect(
      screen.getByText(enSettings.notifications.enabled.label),
    ).toBeInTheDocument();
  });

  it("shows sub-toggles when enabled is true", () => {
    renderWithProviders(<NotificationSettings />);
    expect(
      screen.getByText(enSettings.notifications.inApp.label),
    ).toBeInTheDocument();
    expect(
      screen.getByText(enSettings.notifications.desktop.label),
    ).toBeInTheDocument();
  });

  it("hides sub-toggles when enabled is false", () => {
    getPrefs.mockReturnValue({ enabled: false, inApp: true, desktop: true });
    renderWithProviders(<NotificationSettings />);
    expect(
      screen.queryByText(enSettings.notifications.inApp.label),
    ).not.toBeInTheDocument();
  });

  it("calls setNotificationPrefs with enabled:false when master toggle is turned off", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationSettings />);
    const masterSwitch = screen.getByRole("switch", {
      name: enSettings.notifications.enabled.label,
    });
    await user.click(masterSwitch);
    expect(setPrefs).toHaveBeenCalledWith({ enabled: false });
  });

  it("calls setNotificationPrefs with inApp:false when in-app toggle is turned off", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationSettings />);
    const inAppSwitch = screen.getByRole("switch", {
      name: enSettings.notifications.inApp.label,
    });
    await user.click(inAppSwitch);
    expect(setPrefs).toHaveBeenCalledWith({ inApp: false });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
just test -- src/features/settings/ui/__tests__/NotificationSettings.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement NotificationSettings.tsx**

Create `src/features/settings/ui/NotificationSettings.tsx`:

```typescript
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "@/shared/ui/switch";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import {
  getNotificationPrefs,
  setNotificationPrefs,
  type NotificationPrefs,
} from "@/features/settings/lib/notificationPrefs";

function SettingsSection({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      {title ? <h4 className="text-base text-foreground">{title}</h4> : null}
      <div className="divide-y divide-border overflow-hidden rounded-md bg-background">
        {children}
      </div>
    </section>
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-8 px-4 py-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm">{label}</p>
        {description ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

export function NotificationSettings() {
  const { t } = useTranslation("settings");
  const [prefs, setPrefs] = useState<NotificationPrefs>(getNotificationPrefs);

  function update(patch: Partial<NotificationPrefs>) {
    setNotificationPrefs(patch);
    setPrefs((current) => ({ ...current, ...patch }));
  }

  return (
    <SettingsPage contentClassName="space-y-8">
      <SettingsSection>
        <SettingRow label={t("notifications.enabled.label")}>
          <Switch
            checked={prefs.enabled}
            onCheckedChange={(checked) => update({ enabled: checked })}
            aria-label={t("notifications.enabled.label")}
          />
        </SettingRow>
      </SettingsSection>

      {prefs.enabled && (
        <SettingsSection>
          <SettingRow
            label={t("notifications.inApp.label")}
            description={t("notifications.inApp.description")}
          >
            <Switch
              checked={prefs.inApp}
              onCheckedChange={(checked) => update({ inApp: checked })}
              aria-label={t("notifications.inApp.label")}
            />
          </SettingRow>

          <SettingRow
            label={t("notifications.desktop.label")}
            description={t("notifications.desktop.description")}
          >
            <Switch
              checked={prefs.desktop}
              onCheckedChange={(checked) => update({ desktop: checked })}
              aria-label={t("notifications.desktop.label")}
            />
          </SettingRow>
        </SettingsSection>
      )}
    </SettingsPage>
  );
}
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
just test -- src/features/settings/ui/__tests__/NotificationSettings.test.tsx
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/settings/ui/NotificationSettings.tsx src/features/settings/ui/__tests__/NotificationSettings.test.tsx
git commit -m "feat: add NotificationSettings component"
```

---

## Task 7: Register the Notifications settings section

**Files:**
- Modify: `src/features/settings/ui/settingsSections.ts`
- Modify: `src/features/settings/ui/SettingsView.tsx`

- [ ] **Step 1: Add section to settingsSections.ts**

In `src/features/settings/ui/settingsSections.ts`, add `Bell` to the lucide-react import and add the notifications entry to `SETTINGS_SECTIONS`:

```typescript
import {
  Archive,
  Bell,
  Link2,
  RefreshCw,
  Settings2,
  Stethoscope,
} from "lucide-react";

export const SETTINGS_SECTIONS = [
  { id: "general", labelKey: "nav.general", icon: Settings2 },
  { id: "providers", labelKey: "nav.providers", icon: IconPlug },
  { id: "connections", labelKey: "nav.connections", icon: Link2 },
  { id: "notifications", labelKey: "nav.notifications", icon: Bell },
  { id: "archive", labelKey: "nav.archive", icon: Archive },
  { id: "updates", labelKey: "nav.updates", icon: RefreshCw },
  { id: "doctor", labelKey: "nav.doctor", icon: Stethoscope },
] as const satisfies readonly {
  id: string;
  labelKey: string;
  icon: ComponentType<{ className?: string }>;
}[];
```

- [ ] **Step 2: Import and render NotificationSettings in SettingsView.tsx**

In `src/features/settings/ui/SettingsView.tsx`, add the import:

```typescript
import { NotificationSettings } from "./NotificationSettings";
```

Add the conditional render alongside the other sections (after `{activeSection === "archive" && <ArchiveSettings />}`):

```typescript
      {activeSection === "notifications" && <NotificationSettings />}
```

- [ ] **Step 3: Run full checks**

```bash
just check
```

Expected: exits 0.

- [ ] **Step 4: Run tests**

```bash
just test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/features/settings/ui/settingsSections.ts src/features/settings/ui/SettingsView.tsx
git commit -m "feat: add Notifications settings section"
```

---

## Done

At this point all tasks are complete. Run the full validation gate:

```bash
just ci
```

Expected: all checks and tests pass, app builds successfully.
