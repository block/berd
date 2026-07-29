import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GlobalShortcutBridge } from "./GlobalShortcutBridge";
import {
  GLOBAL_SHORTCUT_ENABLED_STORAGE_KEY,
  setGlobalShortcutEnabled,
} from "@/features/global-shortcut/globalShortcutPreference";
import {
  setShortcutOverride,
  SHORTCUT_PREFERENCES_STORAGE_KEY,
} from "@/features/shortcuts/lib/shortcutRegistry";

const mocks = vi.hoisted(() => ({
  getPlatform: vi.fn(() => "mac"),
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

vi.mock("@/shared/lib/platform", () => ({
  getPlatform: () => mocks.getPlatform(),
}));

function launchCalls() {
  return mocks.invoke.mock.calls.filter(
    ([command]) => command === "launch_global_shortcut_handler",
  );
}

function stopCalls() {
  return mocks.invoke.mock.calls.filter(
    ([command]) => command === "stop_global_shortcut_handler",
  );
}

async function flushAsync() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPlatform.mockReturnValue("mac");
  window.__TAURI_INTERNALS__ = {};
  localStorage.removeItem(GLOBAL_SHORTCUT_ENABLED_STORAGE_KEY);
  localStorage.removeItem(SHORTCUT_PREFERENCES_STORAGE_KEY);
  mocks.invoke.mockResolvedValue(undefined);
});

afterEach(async () => {
  cleanup();
  await flushAsync();
  window.__TAURI_INTERNALS__ = undefined;
  vi.restoreAllMocks();
});

describe("GlobalShortcutBridge", () => {
  it("defaults to disabled", async () => {
    render(<GlobalShortcutBridge />);
    await flushAsync();

    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("does not invoke Tauri commands outside the desktop shell", async () => {
    window.__TAURI_INTERNALS__ = undefined;
    setGlobalShortcutEnabled(true);

    render(<GlobalShortcutBridge />);
    await flushAsync();

    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("does not launch the global shortcut helper off macOS", async () => {
    mocks.getPlatform.mockReturnValue("windows");
    setGlobalShortcutEnabled(true);

    render(<GlobalShortcutBridge />);
    await flushAsync();

    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("stops an active helper if the preference changes in another window", async () => {
    setGlobalShortcutEnabled(true);
    render(<GlobalShortcutBridge />);
    await flushAsync();

    act(() => {
      localStorage.setItem(GLOBAL_SHORTCUT_ENABLED_STORAGE_KEY, "false");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: GLOBAL_SHORTCUT_ENABLED_STORAGE_KEY,
          newValue: "false",
        }),
      );
    });
    await flushAsync();

    expect(stopCalls()).toHaveLength(1);
  });

  it("launches the global shortcut helper hidden when the preference was already enabled at app start", async () => {
    setGlobalShortcutEnabled(true);

    render(<GlobalShortcutBridge />);
    await flushAsync();

    expect(launchCalls()).toEqual([
      [
        "launch_global_shortcut_handler",
        { shortcut: "alt+space", initiallyHidden: true },
      ],
    ]);
    expect(stopCalls()).toHaveLength(0);
  });

  it("launches the global shortcut helper hidden when the preference is toggled on", async () => {
    render(<GlobalShortcutBridge />);
    await flushAsync();

    act(() => {
      setGlobalShortcutEnabled(true);
    });
    await flushAsync();

    expect(launchCalls()).toEqual([
      [
        "launch_global_shortcut_handler",
        { shortcut: "alt+space", initiallyHidden: true },
      ],
    ]);
    expect(stopCalls()).toHaveLength(0);
  });

  it("restarts the global shortcut helper hidden when the configured shortcut changes", async () => {
    render(<GlobalShortcutBridge />);
    await flushAsync();

    act(() => {
      setGlobalShortcutEnabled(true);
    });
    await flushAsync();

    act(() => {
      expect(
        setShortcutOverride("navigation.globalShortcut", "ctrl+alt+c"),
      ).toEqual({
        ok: true,
      });
    });
    await flushAsync();

    expect(launchCalls()).toEqual([
      [
        "launch_global_shortcut_handler",
        { shortcut: "alt+space", initiallyHidden: true },
      ],
      [
        "launch_global_shortcut_handler",
        { shortcut: "ctrl+alt+c", initiallyHidden: true },
      ],
    ]);
  });

  it("queues relaunches so stale shortcut launches cannot finish after newer ones", async () => {
    const firstLaunch = deferred();
    mocks.invoke.mockImplementation((command: string) => {
      if (
        command === "launch_global_shortcut_handler" &&
        launchCalls().length === 1
      ) {
        return firstLaunch.promise;
      }
      return Promise.resolve();
    });

    render(<GlobalShortcutBridge />);
    await flushAsync();

    act(() => {
      setGlobalShortcutEnabled(true);
    });
    await flushAsync();

    act(() => {
      expect(
        setShortcutOverride("navigation.globalShortcut", "ctrl+alt+c"),
      ).toEqual({
        ok: true,
      });
    });
    await flushAsync();

    expect(launchCalls()).toEqual([
      [
        "launch_global_shortcut_handler",
        { shortcut: "alt+space", initiallyHidden: true },
      ],
    ]);

    await act(async () => {
      firstLaunch.resolve();
      await firstLaunch.promise;
    });
    await flushAsync();

    expect(launchCalls()).toEqual([
      [
        "launch_global_shortcut_handler",
        { shortcut: "alt+space", initiallyHidden: true },
      ],
      [
        "launch_global_shortcut_handler",
        { shortcut: "ctrl+alt+c", initiallyHidden: true },
      ],
    ]);
  });

  it("queues stop behind a pending launch when the preference is disabled", async () => {
    const firstLaunch = deferred();
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "launch_global_shortcut_handler") {
        return firstLaunch.promise;
      }
      return Promise.resolve();
    });

    setGlobalShortcutEnabled(true);
    render(<GlobalShortcutBridge />);
    await flushAsync();

    act(() => {
      setGlobalShortcutEnabled(false);
    });
    await flushAsync();

    expect(launchCalls()).toHaveLength(1);
    expect(stopCalls()).toHaveLength(0);

    await act(async () => {
      firstLaunch.resolve();
      await firstLaunch.promise;
    });
    await flushAsync();

    expect(stopCalls()).toHaveLength(1);
  });

  it("does not let a stale failed launch clear a newer same-shortcut launch", async () => {
    const firstLaunch = deferred();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.invoke.mockImplementation((command: string) => {
      if (
        command === "launch_global_shortcut_handler" &&
        launchCalls().length === 1
      ) {
        return firstLaunch.promise;
      }
      return Promise.resolve();
    });

    render(<GlobalShortcutBridge />);
    await flushAsync();

    act(() => {
      setGlobalShortcutEnabled(true);
    });
    await flushAsync();

    act(() => {
      setGlobalShortcutEnabled(false);
    });
    await flushAsync();

    act(() => {
      setGlobalShortcutEnabled(true);
    });
    await flushAsync();

    await act(async () => {
      firstLaunch.reject(new Error("failed first launch"));
      await firstLaunch.promise.catch(() => undefined);
    });
    await flushAsync();

    expect(launchCalls()).toEqual([
      [
        "launch_global_shortcut_handler",
        { shortcut: "alt+space", initiallyHidden: true },
      ],
      [
        "launch_global_shortcut_handler",
        { shortcut: "alt+space", initiallyHidden: true },
      ],
    ]);
    expect(stopCalls()).toHaveLength(1);

    act(() => {
      setGlobalShortcutEnabled(false);
    });
    await flushAsync();

    expect(stopCalls()).toHaveLength(2);
    consoleError.mockRestore();
  });

  it("stops the global shortcut helper when the preference is disabled", async () => {
    setGlobalShortcutEnabled(true);
    render(<GlobalShortcutBridge />);
    await flushAsync();

    act(() => {
      setGlobalShortcutEnabled(false);
    });
    await flushAsync();

    expect(stopCalls()).toHaveLength(1);
  });

  it("stops the global shortcut helper when the bridge unmounts with an active process", async () => {
    render(<GlobalShortcutBridge />);
    await flushAsync();

    act(() => {
      setGlobalShortcutEnabled(true);
    });
    await flushAsync();

    cleanup();
    await flushAsync();

    expect(stopCalls()).toHaveLength(1);
  });
});
