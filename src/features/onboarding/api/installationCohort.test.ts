import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  getInstallationCohort,
  INSTALLATION_COHORT_TIMEOUT_MS,
} from "./installationCohort";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("getInstallationCohort", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("rejects a stalled lookup after the deadline", async () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));
    const result = expect(getInstallationCohort()).rejects.toThrow("timed out");

    await vi.advanceTimersByTimeAsync(INSTALLATION_COHORT_TIMEOUT_MS);

    await result;
  });
});
