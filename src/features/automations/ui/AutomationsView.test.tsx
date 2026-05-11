import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteAutomationTile,
  generateAutomationSchedule,
  getAutomationSessionMessages,
  getAutomationTile,
  getAutomationTileResults,
  getAutomationTiles,
  updateAutomationTile,
} from "@/features/automations/api/kgooseAutomations";
import { AutomationsView } from "./AutomationsView";

vi.mock("@/features/automations/api/kgooseAutomations", () => ({
  getAutomationTiles: vi.fn(),
  getAutomationTile: vi.fn(),
  getAutomationTileResults: vi.fn(),
  getAutomationSessionMessages: vi.fn(),
  updateAutomationTile: vi.fn(),
  deleteAutomationTile: vi.fn(),
  generateAutomationSchedule: vi.fn(),
}));

vi.mock("@/features/automations/ui/AutomationBuilderPanel", () => ({
  AutomationBuilderPanel: ({
    onClose,
    onAutomationCreated,
  }: {
    onClose: () => void;
    onAutomationCreated?: (automationId?: string) => void;
  }) => (
    <section>
      <h2>Add automation</h2>
      <button
        type="button"
        onClick={() => onAutomationCreated?.("automation-3")}
      >
        Finish automation
      </button>
      <button type="button" onClick={onClose}>
        Close builder
      </button>
    </section>
  ),
}));

HTMLElement.prototype.hasPointerCapture ??= () => false;
HTMLElement.prototype.scrollIntoView ??= () => {};

function renderAutomationsView() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <AutomationsView />
    </QueryClientProvider>,
  );
}

describe("AutomationsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAutomationTiles).mockResolvedValue({
      tiles: [
        {
          id: "automation-1",
          title: "Daily revenue digest",
          schedule: "0 9 * * *",
          latestRunStatus: "TILE_RUN_STATUS_SUCCESS",
          lastSuccessAt: "1714568400000",
        },
        {
          id: "automation-2",
          title: "Failed build watcher",
          schedulePaused: true,
          pausedReason: "Manually paused",
          latestRunStatus: "TILE_RUN_STATUS_FAILED",
        },
      ],
    });
    vi.mocked(getAutomationTile).mockResolvedValue({
      tileInfo: {
        id: "automation-1",
        title: "Daily revenue digest",
        schedule: "0 9 * * *",
        timeZone: "America/Los_Angeles",
        latestRunStatus: "TILE_RUN_STATUS_SUCCESS",
        status: "TILE_STATUS_ACTIVE",
        enableNotifications: true,
        humanReadableInstructions: ["Pull revenue", "Send a summary"],
        requiredConnections: ["slack"],
        latestRenderedData: { summary: "Revenue was up." },
      },
    });
    vi.mocked(getAutomationTileResults).mockResolvedValue({
      tilesResults: [
        {
          sessionId: "session-1",
          tileId: "automation-1",
          created: "1714568400000",
          runStatus: "TILE_RUN_STATUS_SUCCESS",
          tileData: { summary: "Run completed." },
        },
      ],
    });
    vi.mocked(updateAutomationTile).mockResolvedValue({ success: true });
    vi.mocked(deleteAutomationTile).mockResolvedValue({ success: true });
    vi.mocked(generateAutomationSchedule).mockResolvedValue({
      success: true,
      cronExpression: "0 9 * * 1-5",
    });
    vi.mocked(getAutomationSessionMessages).mockResolvedValue({
      sessionName: "Daily revenue digest run",
      status: "idle",
      messages: [
        {
          id: "message-1",
          role: "user",
          created: 1714568300000,
          content: [{ type: "text", text: "Run now" }],
        },
        {
          id: "message-2",
          role: "assistant",
          created: 1714568400000,
          content: [
            {
              type: "toolRequest",
              id: "tool-1",
              name: "slack",
              toolName: "slack",
              arguments: { channel: "revenue" },
              status: "completed",
            },
            {
              type: "toolResponse",
              id: "tool-1",
              name: "slack",
              result: "Fetched 3 Slack messages from #revenue.",
              structuredContent: {
                id: "tool-1",
                status: "success",
                extensionName: "slack",
                results: [
                  { text: { text: "Fetched 3 Slack messages from #revenue." } },
                  {
                    structuredContent: {
                      data: { channel: "revenue", count: 3 },
                    },
                  },
                ],
              },
              isError: false,
            },
            {
              type: "text",
              text: "The automation finished.",
            },
          ],
        },
      ],
    });
  });

  it("loads automations and shows selected automation details", async () => {
    renderAutomationsView();

    expect(
      await screen.findByRole("button", { name: /daily revenue digest/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Failed build watcher")).toBeInTheDocument();
    expect(await screen.findByText("Pull revenue")).toBeInTheDocument();
    expect(screen.getByText("Send a summary")).toBeInTheDocument();
    expect(screen.getByText("America/Los_Angeles")).toBeInTheDocument();
    expect(screen.getByText("Revenue was up.")).toBeInTheDocument();
  });

  it("shows historical run output from kgoose tile results", async () => {
    const user = userEvent.setup();
    renderAutomationsView();

    await screen.findByText("Daily revenue digest");
    await user.click(screen.getByRole("tab", { name: "History" }));

    expect(await screen.findByText("Session history")).toBeInTheDocument();
    expect(screen.getAllByText("session-1").length).toBeGreaterThan(0);
    expect(screen.getByText("Run completed.")).toBeInTheDocument();
    expect(screen.getByText("Run now")).toBeInTheDocument();
    expect(
      screen.getByText("Fetched 3 Slack messages from #revenue."),
    ).toBeInTheDocument();
    const slackToolButton = screen.getByText("slack").closest("button");
    expect(slackToolButton).not.toBeNull();
    await user.click(slackToolButton as HTMLButtonElement);
    expect(screen.getByText(/"channel": "revenue"/)).toBeInTheDocument();
    expect(screen.getByText("The automation finished.")).toBeInTheDocument();
    expect(getAutomationTileResults).toHaveBeenCalledWith("automation-1");
    expect(getAutomationSessionMessages).toHaveBeenCalledWith("session-1");
  });

  it("selects the clicked run when session ids repeat", async () => {
    const user = userEvent.setup();
    vi.mocked(getAutomationTileResults).mockResolvedValue({
      tilesResults: [
        {
          sessionId: "shared-session",
          tileId: "automation-1",
          created: "1714568400000",
          runStatus: "TILE_RUN_STATUS_SUCCESS",
          tileData: { summary: "Newer run." },
        },
        {
          sessionId: "shared-session",
          tileId: "automation-1",
          created: "1714568300000",
          runStatus: "TILE_RUN_STATUS_SUCCESS",
          tileData: { summary: "Older run." },
        },
      ],
    });
    renderAutomationsView();

    await screen.findByText("Daily revenue digest");
    await user.click(screen.getByRole("tab", { name: "History" }));

    expect(await screen.findByText("Newer run.")).toBeInTheDocument();

    const runButtons = await screen.findAllByRole("button", {
      name: /shared-session/i,
    });
    await user.click(runButtons[1]);

    expect(await screen.findByText("Older run.")).toBeInTheDocument();
    expect(screen.queryByText("Newer run.")).not.toBeInTheDocument();
  });

  it("selects another automation from the list", async () => {
    const user = userEvent.setup();
    vi.mocked(getAutomationTile).mockImplementation(async (id) => ({
      tileInfo: {
        id,
        title:
          id === "automation-2"
            ? "Failed build watcher"
            : "Daily revenue digest",
        latestRunStatus:
          id === "automation-2"
            ? "TILE_RUN_STATUS_FAILED"
            : "TILE_RUN_STATUS_SUCCESS",
        instructions: [`instructions for ${id}`],
      },
    }));
    renderAutomationsView();

    await user.click(
      await screen.findByRole("button", { name: /failed build watcher/i }),
    );

    const main = screen.getByRole("main");
    expect(
      await within(main).findByText("instructions for automation-2"),
    ).toBeInTheDocument();
    expect(getAutomationTile).toHaveBeenCalledWith("automation-2");
  });

  it("opens the add automation builder inside the automations panel", async () => {
    const user = userEvent.setup();
    renderAutomationsView();

    await user.click(
      await screen.findByRole("button", { name: "Add automation" }),
    );

    expect(
      screen.getByRole("heading", { name: "Add automation" }),
    ).toBeInTheDocument();
  });

  it("selects an automation created by the builder", async () => {
    const user = userEvent.setup();
    vi.mocked(getAutomationTiles)
      .mockResolvedValueOnce({
        tiles: [
          {
            id: "automation-1",
            title: "Daily revenue digest",
            latestRunStatus: "TILE_RUN_STATUS_SUCCESS",
          },
        ],
      })
      .mockResolvedValue({
        tiles: [
          {
            id: "automation-3",
            title: "New automation",
            latestRunStatus: "TILE_RUN_STATUS_SUCCESS",
          },
        ],
      });
    vi.mocked(getAutomationTile).mockImplementation(async (id) => ({
      tileInfo: {
        id,
        title:
          id === "automation-3" ? "New automation" : "Daily revenue digest",
        latestRunStatus: "TILE_RUN_STATUS_SUCCESS",
        instructions: [`instructions for ${id}`],
      },
    }));
    renderAutomationsView();

    await user.click(
      await screen.findByRole("button", { name: "Add automation" }),
    );
    await user.click(screen.getByRole("button", { name: "Finish automation" }));

    expect(await screen.findAllByText("New automation")).not.toHaveLength(0);
    expect(
      screen.queryByRole("heading", { name: "Add automation" }),
    ).toBeNull();
    expect(
      await within(screen.getByRole("main")).findByText(
        "instructions for automation-3",
      ),
    ).toBeInTheDocument();
  });

  it("renders an empty state when no automations are returned", async () => {
    vi.mocked(getAutomationTiles).mockResolvedValue({ tiles: [] });

    renderAutomationsView();

    expect(await screen.findByText("No automations")).toBeInTheDocument();
    expect(
      screen.getByText("kgoose returned no current-user automations."),
    ).toBeInTheDocument();
  });

  it("edits a generic automation", async () => {
    const user = userEvent.setup();
    renderAutomationsView();

    await screen.findByText("Daily revenue digest");
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByText("Pacific Time (PT)")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Title"));
    await user.type(screen.getByLabelText("Title"), "Revenue digest v2");
    const scheduleInput = screen.getByPlaceholderText(
      "0 9 * * * or every weekday at 9am",
    );
    await user.clear(scheduleInput);
    await user.type(scheduleInput, "every weekday at 9am");
    await user.click(screen.getByRole("combobox", { name: "Time zone" }));
    await user.click(
      screen.getByRole("option", {
        name: "Eastern Time (ET)",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Generate cron" }));

    expect(generateAutomationSchedule).toHaveBeenCalledWith(
      "every weekday at 9am",
      "America/New_York",
    );
    expect(await screen.findByDisplayValue("0 9 * * 1-5")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(updateAutomationTile).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "automation-1",
        title: "Revenue digest v2",
        schedule: "0 9 * * 1-5",
        timeZone: "America/New_York",
        updateSchedule: true,
      }),
      expect.anything(),
    );
  });

  it("deletes a generic automation after confirmation", async () => {
    const user = userEvent.setup();
    renderAutomationsView();

    await screen.findByText("Daily revenue digest");
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(
      screen.getByText(/Delete "Daily revenue digest"/),
    ).toBeInTheDocument();

    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(deleteAutomationTile).toHaveBeenCalledWith(
      "automation-1",
      expect.anything(),
    );
  });
});
