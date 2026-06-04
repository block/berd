import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { DoctorReport } from "../doctor";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);

describe("doctor API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs doctor checks through Tauri", async () => {
    const report = { checks: [] };
    mockedInvoke.mockResolvedValue(report);

    const { runDoctor } = await import("../doctor");
    await expect(runDoctor()).resolves.toBe(report);

    expect(mockedInvoke).toHaveBeenCalledWith("run_doctor");
  });

  it("runs doctor fixes with check ID and fix type", async () => {
    mockedInvoke.mockResolvedValue(undefined);

    const { runDoctorFix } = await import("../doctor");
    await runDoctorFix("git", "command");

    expect(mockedInvoke).toHaveBeenCalledWith("run_doctor_fix", {
      checkId: "git",
      fixType: "command",
    });
  });

  it("detects synthetic doctor timeout reports", async () => {
    const { isDoctorTimeoutReport } = await import("../useDoctorReport");

    expect(
      isDoctorTimeoutReport({
        checks: [{ id: "doctor-timeout" }],
      } as DoctorReport),
    ).toBe(true);
    expect(
      isDoctorTimeoutReport({
        checks: [{ id: "git" }],
      } as DoctorReport),
    ).toBe(false);
  });
});
