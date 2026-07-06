import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GlobalShortcutBridge } from "./GlobalShortcutBridge";
import { GLOBAL_SHORTCUT_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import {
  EXPERIMENT_PREFERENCES_STORAGE_KEY,
  setExperimentEnabled,
} from "@/features/experiments/experimentPreferences";
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
  localStorage.removeItem(EXPERIMENT_PREFERENCES_STORAGE_KEY);
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
  it("does not invoke Tauri commands outside the desktop shell", async () => {
    window.__TAURI_INTERNALS__ = undefined;
    setExperimentEnabled(GLOBAL_SHORTCUT_EXPERIMENT_ID, true);

    render(<GlobalShortcutBridge />);
    await flushAsync();

    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("does not launch the global shortcut helper off macOS", async () => {
    mocks.getPlatform.mockReturnValue("windows");
    setExperimentEnabled(GLOBAL_SHORTCUT_EXPERIMENT_ID, true);

    render(<GlobalShortcutBridge />);
    await flushAsync();

    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("launches the global shortcut helper hidden when the experiment was already enabled at app start", async () => {
    setExperimentEnabled(GLOBAL_SHORTCUT_EXPERIMENT_ID, true);

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

  it("launches the global shortcut helper hidden when the experiment is toggled on", async () => {
    render(<GlobalShortcutBridge />);
    await flushAsync();

    act(() => {
      setExperimentEnabled(GLOBAL_SHORTCUT_EXPERIMENT_ID, true);
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
      setExperimentEnabled(GLOBAL_SHORTCUT_EXPERIMENT_ID, true);
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
      setExperimentEnabled(GLOBAL_SHORTCUT_EXPERIMENT_ID, true);
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

  it("queues stop behind a pending launch when the experiment is disabled", async () => {
    const firstLaunch = deferred();
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "launch_global_shortcut_handler") {
        return firstLaunch.promise;
      }
      return Promise.resolve();
    });

    setExperimentEnabled(GLOBAL_SHORTCUT_EXPERIMENT_ID, true);
    render(<GlobalShortcutBridge />);
    await flushAsync();

    act(() => {
      setExperimentEnabled(GLOBAL_SHORTCUT_EXPERIMENT_ID, false);
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
      setExperimentEnabled(GLOBAL_SHORTCUT_EXPERIMENT_ID, true);
    });
    await flushAsync();

    act(() => {
      setExperimentEnabled(GLOBAL_SHORTCUT_EXPERIMENT_ID, false);
    });
    await flushAsync();

    act(() => {
      setExperimentEnabled(GLOBAL_SHORTCUT_EXPERIMENT_ID, true);
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
      setExperimentEnabled(GLOBAL_SHORTCUT_EXPERIMENT_ID, false);
    });
    await flushAsync();

    expect(stopCalls()).toHaveLength(2);
    consoleError.mockRestore();
  });

  it("stops the global shortcut helper when the experiment is disabled", async () => {
    setExperimentEnabled(GLOBAL_SHORTCUT_EXPERIMENT_ID, true);
    render(<GlobalShortcutBridge />);
    await flushAsync();

    act(() => {
      setExperimentEnabled(GLOBAL_SHORTCUT_EXPERIMENT_ID, false);
    });
    await flushAsync();

    expect(stopCalls()).toHaveLength(1);
  });

  it("stops the global shortcut helper when the bridge unmounts with an active process", async () => {
    render(<GlobalShortcutBridge />);
    await flushAsync();

    act(() => {
      setExperimentEnabled(GLOBAL_SHORTCUT_EXPERIMENT_ID, true);
    });
    await flushAsync();

    cleanup();
    await flushAsync();

    expect(stopCalls()).toHaveLength(1);
  });
});
