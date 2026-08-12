import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/api/rendererTelemetry", () => ({
  logRendererEvent: vi.fn(() => Promise.resolve()),
  listenRendererStats: vi.fn(() => Promise.resolve(() => {})),
}));

const LAST_BOOT_KEY = "goose.renderer.lastBootAt";

describe("RendererTelemetry", () => {
  beforeEach(() => {
    // Reset module state so the one-shot boot guard fires again each test.
    vi.resetModules();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("reports a first boot when there is no prior load timestamp", async () => {
    const api = await import("@/shared/api/rendererTelemetry");
    const { RendererTelemetry } = await import("./RendererTelemetry");

    render(<RendererTelemetry />);

    await waitFor(() => {
      expect(api.logRendererEvent).toHaveBeenCalled();
    });
    expect(api.logRendererEvent).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("first load"),
    );
    // Records the boot timestamp for next time.
    expect(localStorage.getItem(LAST_BOOT_KEY)).not.toBeNull();
  });

  it("warns when a reload happens shortly after the previous load", async () => {
    localStorage.setItem(LAST_BOOT_KEY, String(Date.now() - 2_000));

    const api = await import("@/shared/api/rendererTelemetry");
    const { RendererTelemetry } = await import("./RendererTelemetry");

    render(<RendererTelemetry />);

    await waitFor(() => {
      expect(api.logRendererEvent).toHaveBeenCalled();
    });
    expect(api.logRendererEvent).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("unexpected reload"),
    );
  });

  it("treats a long gap since the previous load as a normal boot", async () => {
    localStorage.setItem(LAST_BOOT_KEY, String(Date.now() - 10 * 60_000));

    const api = await import("@/shared/api/rendererTelemetry");
    const { RendererTelemetry } = await import("./RendererTelemetry");

    render(<RendererTelemetry />);

    await waitFor(() => {
      expect(api.logRendererEvent).toHaveBeenCalled();
    });
    expect(api.logRendererEvent).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("previous load"),
    );
  });
});
