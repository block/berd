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

  it("never forwards a renderer-supplied command to run_doctor_fix", async () => {
    // Regression for finding 7: the wire contract carries only the typed
    // (checkId, fixType) identity. Even for an update fix — whose command used
    // to ride along as `commandOverride` — no command string may cross to the
    // backend, so a compromised renderer has no shell escape hatch.
    mockedInvoke.mockResolvedValue(undefined);

    const { runDoctorFix } = await import("../doctor");
    await runDoctorFix("ai-agent-claude", "updateMain");

    const payload = mockedInvoke.mock.calls.at(-1)?.[1] as Record<
      string,
      unknown
    >;
    expect(payload).toEqual({
      checkId: "ai-agent-claude",
      fixType: "updateMain",
    });
    expect(payload).not.toHaveProperty("commandOverride");
    expect(payload).not.toHaveProperty("command");
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
