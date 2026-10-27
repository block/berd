import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listLocalSchedules } from "@/features/automations/api/localSchedules";
import { LocalSchedulesPanel } from "./LocalSchedulesPanel";

vi.mock("@/features/automations/api/localSchedules", () => ({
  LOCAL_SCHEDULES_QUERY_KEY: ["local-goose-schedules"],
  LOCAL_SCHEDULES_REFETCH_INTERVAL_MS: 15_000,
  listLocalSchedules: vi.fn(),
}));

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <LocalSchedulesPanel />
    </QueryClientProvider>,
  );
}

const schedule = {
  id: "weekday-report",
  source: "/Users/test/.config/goose/scheduled_recipes/weekday-report.yaml",
  cron: "0 9 * * 1-5",
  paused: false,
  currentlyRunning: false,
};

describe("LocalSchedulesPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listLocalSchedules).mockResolvedValue([schedule]);
  });

  it("lists local Goose schedules and their current state", async () => {
    renderPanel();

    expect(await screen.findByText("weekday-report")).toBeInTheDocument();
    expect(
      screen.getByText("Recipe file: weekday-report.yaml"),
    ).toBeInTheDocument();
    expect(screen.getByText("0 9 * * 1-5")).toBeInTheDocument();
  });

  it("shows the empty state without hiding the Goose schedules section", async () => {
    vi.mocked(listLocalSchedules).mockResolvedValue([]);
    renderPanel();

    expect(
      await screen.findByText("No local schedules yet"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Goose schedules" }),
    ).toBeInTheDocument();
  });

  it("shows the scheduler error when the first local-schedule request fails", async () => {
    vi.mocked(listLocalSchedules).mockRejectedValue(
      new Error("scheduler disabled"),
    );
    renderPanel();

    expect(
      await screen.findByText("Could not load Goose schedules"),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("scheduler disabled");
  });
});
