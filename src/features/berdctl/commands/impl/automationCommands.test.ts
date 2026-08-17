import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAutomationTile,
  getAutomationTile,
  getAutomationTiles,
  refreshAutomationTile,
} from "@/features/automations/api/kgooseAutomations";
import { getProfileCapabilitySnapshot } from "@/shared/profile/capabilities";

import { createAutomationCommand } from "./createAutomation";
import { getAutomationCommand } from "./getAutomation";
import { listAutomationsCommand } from "./listAutomations";
import { runAutomationCommand } from "./runAutomation";

vi.mock("@/shared/profile/capabilities", () => ({
  getProfileCapabilitySnapshot: vi.fn(),
}));
vi.mock("@/features/automations/api/kgooseAutomations", () => ({
  createAutomationTile: vi.fn(),
  getAutomationTile: vi.fn(),
  getAutomationTiles: vi.fn(),
  refreshAutomationTile: vi.fn(),
}));

const reviewTile = {
  id: "auto-1",
  title: "Review sweep",
  schedule: "0 */30 * * * *",
  timeZone: "America/New_York",
  status: "active",
  latestRunStatus: "success",
  schedulePaused: false,
  instructions: ["Run the review driver"],
  humanReadableInstructions: ["Run the review driver"],
  enableNotifications: true,
  latestChatSessionId: "session-9",
  created: "2026-08-01T00:00:00Z",
  updated: "2026-08-17T00:00:00Z",
};

describe("automation commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProfileCapabilitySnapshot).mockReturnValue(true);
  });

  it("lists automations as wire summaries, filtered by --query", async () => {
    vi.mocked(getAutomationTiles).mockResolvedValue({
      tiles: [reviewTile, { id: "auto-2", title: "Daily digest" }],
    });

    await expect(
      listAutomationsCommand.execute({ query: "review" }, {}),
    ).resolves.toEqual({
      automations: [
        {
          automation_id: "auto-1",
          title: "Review sweep",
          schedule: "0 */30 * * * *",
          time_zone: "America/New_York",
          status: "active",
          latest_run_status: "success",
          schedule_paused: false,
        },
      ],
    });
  });

  it("refuses every action when the automations capability is off", async () => {
    vi.mocked(getProfileCapabilitySnapshot).mockReturnValue(false);

    await expect(listAutomationsCommand.execute({}, {})).rejects.toMatchObject({
      code: "automations_disabled",
    });
    await expect(
      getAutomationCommand.execute({ automation_id: "auto-1" }, {}),
    ).rejects.toMatchObject({ code: "automations_disabled" });
    await expect(
      createAutomationCommand.execute(
        {
          title: "T",
          schedule: "0 0 9 * * *",
          instruction: ["step"],
          enable_notifications: false,
        },
        {},
      ),
    ).rejects.toMatchObject({ code: "automations_disabled" });
    await expect(
      runAutomationCommand.execute({ automation_id: "auto-1" }, {}),
    ).rejects.toMatchObject({ code: "automations_disabled" });
    expect(getAutomationTiles).not.toHaveBeenCalled();
    expect(createAutomationTile).not.toHaveBeenCalled();
    expect(refreshAutomationTile).not.toHaveBeenCalled();
  });

  it("gets one automation's full detail", async () => {
    vi.mocked(getAutomationTile).mockResolvedValue({ tileInfo: reviewTile });

    await expect(
      getAutomationCommand.execute({ automation_id: "auto-1" }, {}),
    ).resolves.toEqual({
      automation_id: "auto-1",
      title: "Review sweep",
      schedule: "0 */30 * * * *",
      time_zone: "America/New_York",
      status: "active",
      latest_run_status: "success",
      schedule_paused: false,
      instructions: ["Run the review driver"],
      human_readable_instructions: ["Run the review driver"],
      enable_notifications: true,
      latest_chat_session_id: "session-9",
      created: "2026-08-01T00:00:00Z",
      updated: "2026-08-17T00:00:00Z",
    });
  });

  it("reports an unknown automation id with the fixing command", async () => {
    vi.mocked(getAutomationTile).mockResolvedValue({});

    await expect(
      getAutomationCommand.execute({ automation_id: "nope" }, {}),
    ).rejects.toMatchObject({
      code: "automation_not_found",
      message: expect.stringContaining("berdctl automation list"),
    });
  });

  it("creates an automation and returns the backend id", async () => {
    vi.mocked(createAutomationTile).mockResolvedValue({
      success: true,
      automationId: "auto-3",
    });

    await expect(
      createAutomationCommand.execute(
        {
          title: "Morning digest",
          schedule: "0 0 9 * * *",
          instruction: ["Summarize unread messages"],
          time_zone: "America/New_York",
          enable_notifications: true,
        },
        {},
      ),
    ).resolves.toEqual({
      automation_id: "auto-3",
      title: "Morning digest",
      schedule: "0 0 9 * * *",
    });
    expect(createAutomationTile).toHaveBeenCalledWith({
      type: 4,
      title: "Morning digest",
      schedule: "0 0 9 * * *",
      instructions: ["Summarize unread messages"],
      timeZone: "America/New_York",
      enableNotifications: true,
    });
  });

  it("surfaces a backend create rejection as a stable command error", async () => {
    vi.mocked(createAutomationTile).mockResolvedValue({
      success: false,
      errorMsg: "invalid cron",
    });

    await expect(
      createAutomationCommand.execute(
        {
          title: "T",
          schedule: "not-cron",
          instruction: ["step"],
          enable_notifications: false,
        },
        {},
      ),
    ).rejects.toMatchObject({
      code: "automation_create_failed",
      message: "invalid cron",
    });
  });

  it("runs an automation now and returns the run session id", async () => {
    vi.mocked(getAutomationTile).mockResolvedValue({ tileInfo: reviewTile });
    vi.mocked(refreshAutomationTile).mockResolvedValue({
      success: true,
      refreshSessionId: "run-42",
    });

    await expect(
      runAutomationCommand.execute({ automation_id: "auto-1" }, {}),
    ).resolves.toEqual({ automation_id: "auto-1", run_session_id: "run-42" });
    expect(refreshAutomationTile).toHaveBeenCalledWith("auto-1");
  });

  it("resolves the automation before running so bad ids read as not-found", async () => {
    vi.mocked(getAutomationTile).mockResolvedValue({});

    await expect(
      runAutomationCommand.execute({ automation_id: "nope" }, {}),
    ).rejects.toMatchObject({ code: "automation_not_found" });
    expect(refreshAutomationTile).not.toHaveBeenCalled();
  });

  it("surfaces a backend run refusal as a stable command error", async () => {
    vi.mocked(getAutomationTile).mockResolvedValue({ tileInfo: reviewTile });
    vi.mocked(refreshAutomationTile).mockResolvedValue({
      success: false,
      errorMsg: "backend busy",
    });

    await expect(
      runAutomationCommand.execute({ automation_id: "auto-1" }, {}),
    ).rejects.toMatchObject({
      code: "automation_run_failed",
      message: "backend busy",
    });
  });
});
