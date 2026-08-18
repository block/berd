import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

/** The public seam must never create telemetry network or native-command work. */
describe("public telemetry seam", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("is inert for app startup and a tracked event", async () => {
    const fetch = vi.fn();
    globalThis.fetch = fetch as typeof globalThis.fetch;
    // The close-flush hooks are installed only once the pipeline is up, so an
    // inert build must leave the teardown paths untouched as well.
    const addWindowListener = vi.spyOn(window, "addEventListener");
    const addDocumentListener = vi.spyOn(document, "addEventListener");
    const telemetry = await import("./client");
    const { berdHomePinPinned } = await import("./events");

    telemetry.initTelemetry();
    telemetry.trackAppLaunched();
    telemetry.track(
      berdHomePinPinned({
        item_type: "HOME_ITEM_TYPE_CHAT",
      }),
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(
      addWindowListener.mock.calls.map(([type]) => String(type)),
    ).not.toContain("pagehide");
    expect(
      addDocumentListener.mock.calls.map(([type]) => String(type)),
    ).not.toContain("visibilitychange");
  });
});
