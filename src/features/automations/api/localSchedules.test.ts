import { beforeEach, describe, expect, it, vi } from "vitest";
import { getClient } from "@/shared/api/acpConnection";
import { listLocalSchedules } from "./localSchedules";

const listSchedules = vi.hoisted(() => vi.fn());

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: vi.fn(async () => ({
    goose: { GooseUnstableSchedulesList: listSchedules },
  })),
}));

describe("local Goose schedules API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
