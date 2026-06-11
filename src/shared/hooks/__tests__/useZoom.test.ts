import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { useZoom } from "../useZoom";

const getPlatformMock = vi.hoisted(() => vi.fn(() => "mac"));
vi.mock("@/shared/lib/platform", () => ({ getPlatform: getPlatformMock }));

const ZOOM_CUSTOM_PROPERTY = "--goose-content-zoom";
const SHORTCUT_PREFERENCES_KEY = "goose:keyboard-shortcuts:v1";

function fireKey(key: string, opts: Partial<KeyboardEventInit> = {}) {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, ...opts }),
  );
}

function clearAppliedZoom() {
  document.documentElement.style.removeProperty(ZOOM_CUSTOM_PROPERTY);
}

function getAppliedZoom() {
  return document.documentElement.style.getPropertyValue(ZOOM_CUSTOM_PROPERTY);
}

async function expectAppliedZoom(level: string) {
  await vi.waitFor(() => expect(getAppliedZoom()).toBe(level));
}

describe("useZoom", () => {
  beforeEach(() => {
    localStorage.clear();
    clearAppliedZoom();
    getPlatformMock.mockReturnValue("mac");
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = true;
  });

  afterEach(() => {
    clearAppliedZoom();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("applies stored zoom on mount", async () => {
    localStorage.setItem("goose-zoom-level", "1.3");
    renderHook(() => useZoom());
    await expectAppliedZoom("1.3");
  });

  it("defaults to 1.0 when nothing stored", async () => {
    renderHook(() => useZoom());
    await expectAppliedZoom("1");
  });

  it("clamps invalid stored values", async () => {
    localStorage.setItem("goose-zoom-level", "10");
    renderHook(() => useZoom());
    await expectAppliedZoom("1.3");
  });

  it("falls back to 1.0 for garbage stored value", async () => {
    localStorage.setItem("goose-zoom-level", "garbage");
    renderHook(() => useZoom());
    await expectAppliedZoom("1");
  });

  it("Cmd+= zooms in", async () => {
    renderHook(() => useZoom());
    await expectAppliedZoom("1");
    fireKey("=", { metaKey: true });
    await expectAppliedZoom("1.1");
    expect(localStorage.getItem("goose-zoom-level")).toBe("1.1");
  });

  it("Cmd+- zooms out", async () => {
    renderHook(() => useZoom());
    await expectAppliedZoom("1");
    fireKey("-", { metaKey: true });
    await expectAppliedZoom("0.9");
  });

  it("Cmd+0 resets to 1.0", async () => {
    localStorage.setItem("goose-zoom-level", "1.3");
    renderHook(() => useZoom());
    await expectAppliedZoom("1.3");
    fireKey("0", { metaKey: true });
    await expectAppliedZoom("1");
  });

  it("Cmd+Shift++ zooms in (mac)", async () => {
    renderHook(() => useZoom());
    await expectAppliedZoom("1");
    fireKey("+", { metaKey: true, shiftKey: true });
    await expectAppliedZoom("1.1");
  });

  it("Ctrl+= works (non-mac)", async () => {
    getPlatformMock.mockReturnValue("linux");
    renderHook(() => useZoom());
    await expectAppliedZoom("1");
    fireKey("=", { ctrlKey: true });
    await expectAppliedZoom("1.1");
  });

  it("ignores Ctrl+= on mac", async () => {
    renderHook(() => useZoom());
    await expectAppliedZoom("1");
    fireKey("=", { ctrlKey: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(getAppliedZoom()).toBe("1");
  });

  it("honors a zoom-in override without remounting", async () => {
    renderHook(() => useZoom());
    await expectAppliedZoom("1");

    localStorage.setItem(
      SHORTCUT_PREFERENCES_KEY,
      JSON.stringify({
        version: 1,
        overrides: { "view.zoomIn": "meta+shift+9" },
      }),
    );

    fireKey("=", { metaKey: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(getAppliedZoom()).toBe("1");

    fireKey("9", { metaKey: true, shiftKey: true });
    await expectAppliedZoom("1.1");
  });

  it("ignores keys without modifier", async () => {
    renderHook(() => useZoom());
    await expectAppliedZoom("1");
    fireKey("=");
    fireKey("-");
    fireKey("0");
    await new Promise((r) => setTimeout(r, 50));
    expect(getAppliedZoom()).toBe("1");
  });

  it("clamps at min boundary", async () => {
    localStorage.setItem("goose-zoom-level", "0.7");
    renderHook(() => useZoom());
    await expectAppliedZoom("0.7");
    fireKey("-", { metaKey: true });
    await expectAppliedZoom("0.7");
  });

  it("clamps at max boundary", async () => {
    localStorage.setItem("goose-zoom-level", "1.3");
    renderHook(() => useZoom());
    await expectAppliedZoom("1.3");
    fireKey("=", { metaKey: true });
    await expectAppliedZoom("1.3");
  });

  it("does not handle zoom shortcuts without __TAURI_INTERNALS__", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    renderHook(() => useZoom());
    fireKey("=", { metaKey: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(getAppliedZoom()).toBe("");
  });

  it("cleans up listener on unmount", () => {
    const spy = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useZoom());
    unmount();
    expect(spy).toHaveBeenCalledWith("keydown", expect.any(Function));
    spy.mockRestore();
  });
});
