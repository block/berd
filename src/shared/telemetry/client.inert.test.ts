import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const submitFeedbackIssue = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(() => "1.0.0") }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/shared/api/feedback", () => ({ submitFeedbackIssue }));
vi.mock("@/shared/lib/platform", () => ({ getPlatform: () => "mac" }));

/** The public seam must never create telemetry network or native-command work. */
describe("public telemetry seam", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    submitFeedbackIssue.mockResolvedValue({
      issueUrl: "https://example.test/1",
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("is inert for app startup and successful feedback submission", async () => {
    const fetch = vi.fn();
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const telemetry = await import("./client");
    const { submitFeedbackReport } = await import(
      "@/features/feedback/submitFeedbackReport"
    );

    telemetry.initTelemetry();
    telemetry.trackAppLaunched();
    await expect(
      submitFeedbackReport({
        title: "Feedback",
        description: "Details",
        includeLogs: false,
      }),
    ).resolves.toEqual({ issueUrl: "https://example.test/1" });

    expect(fetch).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
