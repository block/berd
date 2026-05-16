import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAutomationTile,
  deleteAutomationTile,
  getAutomationSessionMessages,
  getAutomationTile,
  getAutomationTileResults,
  getAutomationTiles,
  updateAutomationTile,
} from "@/features/automations/api/kgooseAutomations";
import { AutomationsWorkbench as AutomationsView } from "./AutomationsView";

if (!HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
}

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
}

vi.mock("@/features/automations/api/kgooseAutomations", () => ({
  getAutomationTiles: vi.fn(),
  getAutomationTile: vi.fn(),
  getAutomationTileResults: vi.fn(),
  getAutomationSessionMessages: vi.fn(),
  createAutomationTile: vi.fn(),
  updateAutomationTile: vi.fn(),
  deleteAutomationTile: vi.fn(),
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
          updated: "1714568400000",
          enableNotifications: true,
          latestRenderedData: { summary: "Revenue was up." },
          requiredConnections: ["slack"],
        },
        {
          id: "automation-2",
          title: "Failed build watcher",
          schedulePaused: true,
          pausedReason: "Manually paused",
          latestRunStatus: "TILE_RUN_STATUS_FAILED",
          updated: "1714568500000",
          latestRenderedData: { summary: "Build failed on main." },
        },
      ],
    });
    vi.mocked(getAutomationTile).mockResolvedValue({
      tileInfo: {
        id: "automation-1",
        title: "Daily revenue digest",
        schedule: "0 9 * * *",
        type: "TILE_TYPE_SUMMARY",
        timeZone: "America/Los_Angeles",
        latestRunStatus: "TILE_RUN_STATUS_SUCCESS",
        status: "TILE_STATUS_ACTIVE",
        lastSuccessAt: "1714568400000",
        updated: "1714568400000",
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
    vi.mocked(createAutomationTile).mockResolvedValue({
      success: true,
      tileId: "automation-copy",
    });
    vi.mocked(deleteAutomationTile).mockResolvedValue({ success: true });
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

  it("loads automations into a quiet overview list", async () => {
    renderAutomationsView();

    expect(
      (await screen.findAllByText("Daily revenue digest")).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Failed build watcher")).toBeInTheDocument();
    expect(screen.queryByText("Your automations")).not.toBeInTheDocument();
    expect(screen.queryByText("Last status")).not.toBeInTheDocument();
    expect(screen.queryByText("Recent notifications")).not.toBeInTheDocument();
    expect(screen.getByText("Revenue was up.")).toBeInTheDocument();
  });

  it("opens automation details from the overview", async () => {
    const user = userEvent.setup();
    renderAutomationsView();

    await user.click(
      await screen.findByRole("button", { name: "Daily revenue digest" }),
    );

    const instructionsText = await screen.findByText(
      /Pull revenue\s+Send a summary/,
    );
    expect(
      screen
        .getByText("Latest result")
        .compareDocumentPosition(instructionsText) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "Time zone" }),
    ).toHaveTextContent("America/Los_Angeles");
    expect(
      screen.queryByRole("button", { name: "Add automation" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add" }),
    ).not.toBeInTheDocument();
  });

  it("edits instructions with explicit save and cancel controls", async () => {
    const user = userEvent.setup();
    renderAutomationsView();

    await user.click(
      await screen.findByRole("button", { name: "Daily revenue digest" }),
    );

    await user.click(
      await screen.findByRole("button", { name: "Edit instructions" }),
    );
    const instructionsEditor = screen.getByRole("textbox", {
      name: "Instructions",
    });
    await user.clear(instructionsEditor);
    await user.type(instructionsEditor, "Pull revenue{enter}Send a chart");
    await user.tab();

    expect(updateAutomationTile).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByText(/Pull revenue\s+Send a summary/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Edit instructions" }));
    const reopenedEditor = screen.getByRole("textbox", {
      name: "Instructions",
    });
    await user.clear(reopenedEditor);
    await user.type(reopenedEditor, "Pull revenue{enter}Send a chart");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(updateAutomationTile).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "automation-1",
          updateInstructions: true,
          instructions: ["Pull revenue", "Send a chart"],
        }),
        expect.anything(),
      ),
    );
  });

  it("keeps the schedule in the detail run settings", async () => {
    const user = userEvent.setup();
    renderAutomationsView();

    expect(await screen.findAllByText("Daily at 9:00 AM")).not.toHaveLength(0);
    expect(screen.getAllByText(/Last ran/)[0].closest("span")).toHaveClass(
      "text-placeholder",
    );

    await user.click(
      await screen.findByRole("button", { name: "Daily revenue digest" }),
    );

    expect(screen.getByLabelText("Time")).toHaveValue("09:00");
    expect(screen.queryByText(/^Runs /)).not.toBeInTheDocument();
    expect(screen.getByText(/Last ran/).closest("span")).toHaveClass(
      "text-placeholder",
    );
    expect(screen.queryByText("Status")).not.toBeInTheDocument();
  });

  it("formats recent run activity with relative day labels", async () => {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const weekday = new Date(now);
    weekday.setDate(now.getDate() - 3);
    const older = new Date(now);
    older.setDate(now.getDate() - 8);
    const formatTime = (date: Date) =>
      new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).format(date);
    const formatDateTime = (date: Date) =>
      new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(date);
    const weekdayLabel = new Intl.DateTimeFormat(undefined, {
      weekday: "long",
    }).format(weekday);

    vi.mocked(getAutomationTiles).mockResolvedValue({
      tiles: [
        {
          id: "today",
          title: "Today automation",
          latestRunStatus: "TILE_RUN_STATUS_SUCCESS",
          updated: String(now.getTime()),
        },
        {
          id: "yesterday",
          title: "Yesterday automation",
          latestRunStatus: "TILE_RUN_STATUS_SUCCESS",
          updated: String(yesterday.getTime()),
        },
        {
          id: "weekday",
          title: "Weekday automation",
          latestRunStatus: "TILE_RUN_STATUS_SUCCESS",
          updated: String(weekday.getTime()),
        },
        {
          id: "older",
          title: "Older automation",
          latestRunStatus: "TILE_RUN_STATUS_SUCCESS",
          updated: String(older.getTime()),
        },
      ],
    });

    renderAutomationsView();

    expect(
      await screen.findByText(`Last ran today at ${formatTime(now)}`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`Last ran yesterday at ${formatTime(yesterday)}`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`Last ran ${weekdayLabel} at ${formatTime(weekday)}`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`Last ran ${formatDateTime(older)}`),
    ).toBeInTheDocument();
  });

  it("formats history run timestamps with relative day labels", async () => {
    const user = userEvent.setup();
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const weekday = new Date(now);
    weekday.setDate(now.getDate() - 3);
    const older = new Date(now);
    older.setDate(now.getDate() - 8);
    const formatTime = (date: Date) =>
      new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).format(date);
    const formatDateTime = (date: Date) =>
      new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(date);
    const weekdayLabel = new Intl.DateTimeFormat(undefined, {
      weekday: "long",
    }).format(weekday);

    vi.mocked(getAutomationTiles).mockResolvedValue({
      tiles: [
        {
          id: "automation-1",
          title: "Daily history",
          latestRunStatus: "TILE_RUN_STATUS_SUCCESS",
        },
      ],
    });
    vi.mocked(getAutomationTileResults).mockResolvedValue({
      tilesResults: [
        {
          sessionId: "today-run",
          tileId: "automation-1",
          created: String(now.getTime()),
          runStatus: "TILE_RUN_STATUS_SUCCESS",
        },
        {
          sessionId: "yesterday-run",
          tileId: "automation-1",
          created: String(yesterday.getTime()),
          runStatus: "TILE_RUN_STATUS_SUCCESS",
        },
        {
          sessionId: "weekday-run",
          tileId: "automation-1",
          created: String(weekday.getTime()),
          runStatus: "TILE_RUN_STATUS_SUCCESS",
        },
        {
          sessionId: "older-run",
          tileId: "automation-1",
          created: String(older.getTime()),
          runStatus: "TILE_RUN_STATUS_SUCCESS",
        },
      ],
    });

    renderAutomationsView();

    await user.click(screen.getByRole("tab", { name: "History" }));

    expect(
      await screen.findByText(`Today at ${formatTime(now)}`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`Yesterday at ${formatTime(yesterday)}`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`${weekdayLabel} at ${formatTime(weekday)}`),
    ).toBeInTheDocument();
    expect(screen.getByText(formatDateTime(older))).toBeInTheDocument();
  });

  it("groups destructive detail actions under the more menu", async () => {
    const user = userEvent.setup();
    renderAutomationsView();

    await user.click(
      await screen.findByRole("button", { name: "Daily revenue digest" }),
    );
    await screen.findByText(/Pull revenue\s+Send a summary/);

    expect(screen.queryByRole("button", { name: "Run" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "More actions" }));

    const deleteIcon = screen
      .getByRole("menuitem", { name: "Delete" })
      .querySelector("svg");

    expect(deleteIcon).toHaveClass("size-3.5");
  });

  it("shows historical run output from kgoose tile results", async () => {
    const user = userEvent.setup();
    renderAutomationsView();

    await user.click(screen.getByRole("tab", { name: "History" }));

    expect(screen.queryByText("Session history")).not.toBeInTheDocument();

    await user.click(
      await screen.findByRole("button", { name: /Daily revenue digest/i }),
    );

    expect(await screen.findByText("Session history")).toBeInTheDocument();
    expect(screen.getAllByText("session-1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Run completed.").length).toBeGreaterThan(0);
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

  it("opens global history runs in place before navigating to the automation", async () => {
    const user = userEvent.setup();
    renderAutomationsView();

    await user.click(screen.getByRole("tab", { name: "History" }));
    await user.click(
      await screen.findByRole("button", { name: /Daily revenue digest/i }),
    );

    expect(await screen.findByText("Session history")).toBeInTheDocument();
    expect(screen.getAllByText("Run completed.").length).toBeGreaterThan(0);
    expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Go to automation" }));

    expect(await screen.findByRole("textbox", { name: "Title" })).toHaveValue(
      "Daily revenue digest",
    );
    expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute(
      "data-state",
      "active",
    );
    expect(screen.getAllByText("Run completed.").length).toBeGreaterThan(0);
  });

  it("selects the clicked run when session ids repeat", async () => {
    const user = userEvent.setup();
    vi.mocked(getAutomationTileResults).mockImplementation(async (id) => ({
      tilesResults:
        id === "automation-1"
          ? [
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
            ]
          : [],
    }));
    renderAutomationsView();

    await user.click(screen.getByRole("tab", { name: "History" }));

    expect(await screen.findByText("Newer run.")).toBeInTheDocument();

    const runButtons = await screen.findAllByRole("button", {
      name: /Daily revenue digest/i,
    });
    await user.click(runButtons[1]);

    const output = (
      await screen.findByRole("heading", { name: "Session history" })
    ).closest("section");
    expect(output).not.toBeNull();
    expect(
      within(output as HTMLElement).getByText("Older run."),
    ).toBeInTheDocument();
    expect(
      within(output as HTMLElement).queryByText("Newer run."),
    ).not.toBeInTheDocument();
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
      await screen.findByRole("button", { name: "Failed build watcher" }),
    );

    expect(
      await screen.findByText("instructions for automation-2"),
    ).toHaveTextContent("instructions for automation-2");
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
      await screen.findByText("instructions for automation-3"),
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

    await user.click(
      await screen.findByRole("button", { name: "Daily revenue digest" }),
    );
    await user.clear(screen.getByLabelText("Title"));
    await user.type(screen.getByLabelText("Title"), "Revenue digest v2");

    await user.tab();
    await waitFor(() => {
      expect(updateAutomationTile).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "automation-1",
          title: "Revenue digest v2",
        }),
        expect.anything(),
      );
    });

    await user.click(screen.getByRole("combobox", { name: "Repeats" }));
    await user.click(await screen.findByRole("option", { name: "Weekdays" }));

    await waitFor(() => {
      expect(updateAutomationTile).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "automation-1",
          schedule: "0 9 * * 1-5",
          updateSchedule: true,
        }),
        expect.anything(),
      );
    });

    await user.click(screen.getByRole("combobox", { name: "Time zone" }));
    await user.type(
      screen.getByPlaceholderText("Search timezones"),
      "New_York",
    );
    await user.click(
      await screen.findByRole("option", { name: "America/New_York" }),
    );

    await waitFor(() => {
      expect(updateAutomationTile).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "automation-1",
          timeZone: "America/New_York",
          updateSchedule: true,
        }),
        expect.anything(),
      );
    });
  });

  it("deletes a generic automation after confirmation", async () => {
    const user = userEvent.setup();
    renderAutomationsView();

    await user.click(
      await screen.findByRole("button", { name: "Daily revenue digest" }),
    );
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));

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

  it("duplicates a generic automation from the selected details", async () => {
    const user = userEvent.setup();
    renderAutomationsView();

    await user.click(
      await screen.findByRole("button", { name: "Daily revenue digest" }),
    );
    await screen.findByText(/Pull revenue\s+Send a summary/);
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Duplicate" }));

    expect(createAutomationTile).toHaveBeenCalledWith({
      type: "TILE_TYPE_SUMMARY",
      title: "Daily revenue digest (copy)",
      schedule: "0 9 * * *",
      timeZone: "America/Los_Angeles",
      instructions: ["Pull revenue", "Send a summary"],
      allowHumanInput: undefined,
      enableNotifications: true,
    });
  });

  it("duplicates non-summary automation tile types from the selected details", async () => {
    const user = userEvent.setup();
    vi.mocked(getAutomationTile).mockResolvedValue({
      tileInfo: {
        id: "automation-1",
        title: "Daily revenue digest",
        schedule: "0 9 * * *",
        type: "TILE_TYPE_AUTOMATION",
        timeZone: "America/Los_Angeles",
        latestRunStatus: "TILE_RUN_STATUS_SUCCESS",
        humanReadableInstructions: ["Pull revenue", "Send a summary"],
        latestRenderedData: { summary: "Revenue was up." },
      },
    });

    renderAutomationsView();

    await user.click(
      await screen.findByRole("button", { name: "Daily revenue digest" }),
    );
    await screen.findByText(/Pull revenue\s+Send a summary/);
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Duplicate" }));

    expect(createAutomationTile).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "TILE_TYPE_AUTOMATION",
      }),
    );
    expect(createAutomationTile).toHaveBeenCalledWith(
      expect.not.objectContaining({
        latestRenderedData: expect.anything(),
      }),
    );
  });

  it("does not duplicate unsupported automation tile types", async () => {
    const user = userEvent.setup();
    vi.mocked(getAutomationTile).mockResolvedValue({
      tileInfo: {
        id: "automation-1",
        title: "Daily revenue digest",
        schedule: "0 9 * * *",
        type: "TILE_TYPE_TASK",
        timeZone: "America/Los_Angeles",
        latestRunStatus: "TILE_RUN_STATUS_SUCCESS",
        humanReadableInstructions: ["Pull revenue", "Send a summary"],
      },
    });

    renderAutomationsView();

    await user.click(
      await screen.findByRole("button", { name: "Daily revenue digest" }),
    );
    await screen.findByText(/Pull revenue\s+Send a summary/);
    await user.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menuitem", { name: "Duplicate" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    expect(createAutomationTile).not.toHaveBeenCalled();
  });

  it("does not duplicate unknown automation tile types", async () => {
    const user = userEvent.setup();
    vi.mocked(getAutomationTile).mockResolvedValue({
      tileInfo: {
        id: "automation-1",
        title: "Daily revenue digest",
        schedule: "0 9 * * *",
        type: "TILE_TYPE_EXPERIMENTAL",
        timeZone: "America/Los_Angeles",
        latestRunStatus: "TILE_RUN_STATUS_SUCCESS",
        humanReadableInstructions: ["Pull revenue", "Send a summary"],
      },
    });

    renderAutomationsView();

    await user.click(
      await screen.findByRole("button", { name: "Daily revenue digest" }),
    );
    await screen.findByText(/Pull revenue\s+Send a summary/);
    await user.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menuitem", { name: "Duplicate" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(createAutomationTile).not.toHaveBeenCalled();
  });
});
