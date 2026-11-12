import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatDate } from "@/shared/i18n";
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
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("refreshes schedules with the shared button icon sizing", async () => {
    const user = userEvent.setup();
    let finishRefresh!: (schedules: (typeof schedule)[]) => void;
    renderPanel();

    expect(await screen.findByText("weekday-report")).toBeInTheDocument();
    const refresh = screen.getByRole("button", { name: "Refresh" });
    expect(refresh).toBeEnabled();
    const icon = refresh.querySelector('[data-slot="button-left-icon"] svg');
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveClass("size-3");
    expect(icon).toHaveAttribute("aria-hidden", "true");

    vi.mocked(listLocalSchedules).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRefresh = resolve;
        }),
    );
    await user.click(refresh);
    expect(listLocalSchedules).toHaveBeenCalledTimes(2);
    expect(refresh).toBeDisabled();

    finishRefresh([{ ...schedule, paused: true }]);
    expect(await screen.findByText("Paused")).toBeInTheDocument();
    expect(refresh).toBeEnabled();
    expect(refresh).toHaveAccessibleName("Refresh");
  });

  it("labels paused schedules instead of active", async () => {
    vi.mocked(listLocalSchedules).mockResolvedValue([
      { ...schedule, paused: true },
    ]);
    renderPanel();
    expect(await screen.findByText("Paused")).toBeInTheDocument();
    expect(screen.queryByText("Active")).not.toBeInTheDocument();
  });

  it("formats last run with the app locale", async () => {
    const lastRun = "2026-11-04T09:00:00Z";
    vi.mocked(listLocalSchedules).mockResolvedValue([{ ...schedule, lastRun }]);
    renderPanel();
    const formatted = formatDate(lastRun, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    expect(
      await screen.findByText(`Last run: ${formatted}`),
    ).toBeInTheDocument();
    expect(screen.queryByText(lastRun)).not.toBeInTheDocument();
  });

  it("uses a safe fallback for invalid last run values", async () => {
    vi.mocked(listLocalSchedules).mockResolvedValue([
      { ...schedule, lastRun: "invalid" },
    ]);
    renderPanel();
    expect(await screen.findByText("Last run: Unknown")).toBeInTheDocument();
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
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("data-slot", "alert");
    expect(alert).toHaveTextContent("Could not load Goose schedules");
    expect(alert).toHaveTextContent("scheduler disabled");
  });
});
