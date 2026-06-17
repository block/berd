import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { createElement, Fragment } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isDocumentVisible,
  resolveRenderWindowVisible,
  useRenderWindowVisible,
} from "./renderVisibility";

const tauriWindowApi = vi.hoisted(() => ({
  getCurrentWindow: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: tauriWindowApi.getCurrentWindow,
}));

function setVisibilityState(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
}

function setTauriInternals(value: unknown) {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value,
  });
}

function VisibilityProbe({ testId }: { testId: string }) {
  const visible = useRenderWindowVisible();
  return createElement("div", { "data-testid": testId }, String(visible));
}

describe("renderVisibility", () => {
  const originalVisibilityState = document.visibilityState;

  afterEach(() => {
    cleanup();
    setVisibilityState(originalVisibilityState);
    delete window.__TAURI_INTERNALS__;
    tauriWindowApi.getCurrentWindow.mockReset();
    vi.clearAllMocks();
  });

  it("treats only hidden documents as not visible", () => {
    setVisibilityState("visible");
    expect(isDocumentVisible()).toBe(true);

    setVisibilityState("hidden");
    expect(isDocumentVisible()).toBe(false);
  });

  it("treats minimized Tauri windows as not visible", async () => {
    setVisibilityState("visible");

    await expect(
      resolveRenderWindowVisible({
        isMinimized: vi.fn().mockResolvedValue(true),
        isVisible: vi.fn().mockResolvedValue(true),
      } as never),
    ).resolves.toBe(false);
  });

  it("does not query Tauri window state when the document is hidden", async () => {
    setVisibilityState("hidden");
    const appWindow = {
      isMinimized: vi.fn().mockResolvedValue(false),
      isVisible: vi.fn().mockResolvedValue(true),
    };

    await expect(resolveRenderWindowVisible(appWindow as never)).resolves.toBe(
      false,
    );
    expect(appWindow.isMinimized).not.toHaveBeenCalled();
    expect(appWindow.isVisible).not.toHaveBeenCalled();
  });

  it("shares one Tauri window subscription across mounted renderers", async () => {
    setVisibilityState("visible");
    setTauriInternals({});
    const appWindow = {
      isMinimized: vi.fn().mockResolvedValue(false),
      isVisible: vi.fn().mockResolvedValue(true),
      onFocusChanged: vi.fn().mockResolvedValue(vi.fn()),
      onResized: vi.fn().mockResolvedValue(vi.fn()),
    };
    tauriWindowApi.getCurrentWindow.mockReturnValue(appWindow);

    render(
      createElement(
        Fragment,
        null,
        createElement(VisibilityProbe, { testId: "first" }),
        createElement(VisibilityProbe, { testId: "second" }),
      ),
    );

    await waitFor(() => {
      expect(appWindow.onFocusChanged).toHaveBeenCalledTimes(1);
    });
    expect(appWindow.onResized).toHaveBeenCalledTimes(1);
    expect(tauriWindowApi.getCurrentWindow).toHaveBeenCalledTimes(1);
  });

  it("ignores stale visible Tauri checks after the document becomes hidden", async () => {
    setVisibilityState("visible");
    setTauriInternals({});
    const visibleResolvers: Array<(value: boolean) => void> = [];
    const appWindow = {
      isMinimized: vi.fn().mockResolvedValue(false),
      isVisible: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            visibleResolvers.push(resolve);
          }),
      ),
      onFocusChanged: vi.fn().mockResolvedValue(vi.fn()),
      onResized: vi.fn().mockResolvedValue(vi.fn()),
    };
    tauriWindowApi.getCurrentWindow.mockReturnValue(appWindow);

    render(createElement(VisibilityProbe, { testId: "visible" }));

    await waitFor(() => {
      expect(appWindow.isVisible).toHaveBeenCalled();
    });

    act(() => {
      setVisibilityState("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("visible")).toHaveTextContent("false");
    });

    await act(async () => {
      for (const resolve of visibleResolvers) {
        resolve(true);
      }
      await Promise.resolve();
    });

    expect(screen.getByTestId("visible")).toHaveTextContent("false");
  });
});
