import { beforeEach, describe, expect, it, vi } from "vitest";
import { getClient } from "@/shared/api/acpConnection";
import { listLocalSchedules, updateLocalScheduleCron } from "./localSchedules";

const listSchedules = vi.hoisted(() => vi.fn());
const updateSchedule = vi.hoisted(() => vi.fn());

vi.mock("@/shared/api/acpConnection", () => ({
  captureBackendConnectionGeneration: vi.fn(() => ({
    isCurrent: () => true,
    invalidate: vi.fn().mockResolvedValue(undefined),
  })),
  getClient: vi.fn(async () => ({
    goose: {
      GooseUnstableSchedulesList: listSchedules,
      GooseUnstableSchedulesUpdate: updateSchedule,
    },
  })),
}));

describe("local Goose schedules API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateSchedule.mockResolvedValue({
      job: {
        id: "weekday-report",
        source: "/tmp/scheduled_recipes/weekday-report.yaml",
        cron: "0 10 * * 1-5",
        currentlyRunning: false,
        paused: true,
      },
    });
    listSchedules.mockResolvedValue({
      jobs: [
        {
          id: "weekday-report",
          source: "/tmp/scheduled_recipes/weekday-report.yaml",
          cron: "0 9 * * 1-5",
          currentlyRunning: false,
          paused: false,
        },
      ],
    });
  });

  it("lists schedules through the connected Goose instance", async () => {
    await expect(listLocalSchedules()).resolves.toEqual([
      {
        id: "weekday-report",
        source: "/tmp/scheduled_recipes/weekday-report.yaml",
        cron: "0 9 * * 1-5",
        currentlyRunning: false,
        paused: false,
      },
    ]);
    expect(getClient).toHaveBeenCalledOnce();
    expect(listSchedules).toHaveBeenCalledWith({});
  });

  it("updates a schedule through the connected Goose instance", async () => {
    await expect(
      updateLocalScheduleCron("weekday-report", "0 10 * * 1-5"),
    ).resolves.toMatchObject({ cron: "0 10 * * 1-5", paused: true });
    expect(updateSchedule).toHaveBeenCalledWith({
      scheduleId: "weekday-report",
      cron: "0 10 * * 1-5",
    });
  });
});
