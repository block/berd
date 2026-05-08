import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAutomationTile,
  getAutomationTileResults,
  getAutomationTiles,
} from "@/features/automations/api/kgooseAutomations";
import { AutomationsView } from "./AutomationsView";

vi.mock("@/features/automations/api/kgooseAutomations", () => ({
  getAutomationTiles: vi.fn(),
  getAutomationTile: vi.fn(),
  getAutomationTileResults: vi.fn(),
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

    expect(await screen.findByText("Run output")).toBeInTheDocument();
    expect(screen.getAllByText("session-1").length).toBeGreaterThan(0);
    expect(screen.getByText("Run completed.")).toBeInTheDocument();
    expect(getAutomationTileResults).toHaveBeenCalledWith("automation-1");
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

  it("renders an empty state when no automations are returned", async () => {
    vi.mocked(getAutomationTiles).mockResolvedValue({ tiles: [] });

    renderAutomationsView();

    expect(await screen.findByText("No automations")).toBeInTheDocument();
    expect(
      screen.getByText("kgoose returned no current-user automations."),
    ).toBeInTheDocument();
  });
});
