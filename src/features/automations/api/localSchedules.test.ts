import { beforeEach, describe, expect, it, vi } from "vitest";
import { getClient } from "@/shared/api/acpConnection";
import { removeLocalSchedule } from "./localSchedules";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  pause: vi.fn(),
  unpause: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: vi.fn(async () => ({
    goose: {
      GooseUnstableSchedulesList: mocks.list,
      GooseUnstableSchedulesPause: mocks.pause,
      GooseUnstableSchedulesUnpause: mocks.unpause,
      GooseUnstableSchedulesDelete: mocks.remove,
    },
  })),
}));

describe("removeLocalSchedule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue({
      jobs: [{ id: "daily-report", paused: false, currentlyRunning: false }],
    });
    mocks.pause.mockResolvedValue(undefined);
    mocks.unpause.mockResolvedValue(undefined);
    mocks.remove.mockResolvedValue(undefined);
  });

  it("pauses an idle schedule before removing it", async () => {
    await removeLocalSchedule("daily-report");

    expect(getClient).toHaveBeenCalledOnce();
    expect(mocks.pause).toHaveBeenCalledWith({ scheduleId: "daily-report" });
    expect(mocks.remove).toHaveBeenCalledWith({ scheduleId: "daily-report" });
    expect(mocks.unpause).not.toHaveBeenCalled();
  });

  it("restores the prior state when removal fails", async () => {
    mocks.remove.mockRejectedValue(new Error("delete failed"));

    await expect(removeLocalSchedule("daily-report")).rejects.toThrow(
      "delete failed",
    );
    expect(mocks.unpause).toHaveBeenCalledWith({ scheduleId: "daily-report" });
  });

  it("does not alter an already-paused schedule when removal fails", async () => {
    mocks.list.mockResolvedValue({
      jobs: [{ id: "daily-report", paused: true, currentlyRunning: false }],
    });
    mocks.remove.mockRejectedValue(new Error("delete failed"));

    await expect(removeLocalSchedule("daily-report")).rejects.toThrow(
      "delete failed",
    );
    expect(mocks.pause).not.toHaveBeenCalled();
    expect(mocks.unpause).not.toHaveBeenCalled();
  });
});
