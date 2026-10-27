import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatDate } from "@/shared/i18n";
import { listLocalSchedules, updateLocalScheduleCron } from "@/features/automations/api/localSchedules";
import { LocalSchedulesPanel } from "./LocalSchedulesPanel";

vi.mock("@/features/automations/api/localSchedules", () => ({
  LOCAL_SCHEDULES_QUERY_KEY: ["local-goose-schedules"],
  LOCAL_SCHEDULES_REFETCH_INTERVAL_MS: 15_000,
  listLocalSchedules: vi.fn(),
  updateLocalScheduleCron: vi.fn(),
}));

function deferred<T>() {
  let resolvePromise: (value: T) => void = () => {
    throw new Error("Deferred promise was resolved before initialization");
  };
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

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
    vi.resetAllMocks();
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

  it("saves valid cron edits and refreshes the Goose schedule list", async () => {
    vi.mocked(updateLocalScheduleCron).mockResolvedValue({
      ...schedule,
      cron: "0 10 * * 1-5",
    });
    vi.mocked(listLocalSchedules)
      .mockResolvedValueOnce([schedule])
      .mockResolvedValueOnce([{ ...schedule, cron: "0 10 * * 1-5" }]);
    renderPanel();

    await screen.findByText("weekday-report");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Edit cron schedule for weekday-report",
      }),
    );
    const input = screen.getByLabelText("Cron expression for weekday-report");
    expect(input).toHaveValue("0 9 * * 1-5");

    fireEvent.change(input, { target: { value: "0 10 * * 1-5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateLocalScheduleCron).toHaveBeenCalledWith(
        "weekday-report",
        "0 10 * * 1-5",
      ),
    );
    await waitFor(() =>
      expect(screen.getByText("0 10 * * 1-5")).toBeInTheDocument(),
    );
    expect(listLocalSchedules).toHaveBeenCalledTimes(2);
  });

  it("keeps the latest list response when a mutation resolves after a newer poll", async () => {
    const mutation = deferred<typeof schedule>();
    const newerPoll = deferred<(typeof schedule)[]>();
    vi.mocked(updateLocalScheduleCron).mockReturnValue(mutation.promise);
    vi.mocked(listLocalSchedules)
      .mockResolvedValueOnce([schedule])
      .mockReturnValueOnce(newerPoll.promise)
      .mockResolvedValueOnce([
        { ...schedule, cron: "0 11 * * 1-5", paused: true },
      ]);
    const { unmount } = renderPanel();

    await screen.findByText("weekday-report");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Edit cron schedule for weekday-report",
      }),
    );
    const input = screen.getByLabelText("Cron expression for weekday-report");
    fireEvent.change(input, { target: { value: "0 10 * * 1-5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateLocalScheduleCron).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(listLocalSchedules).toHaveBeenCalledTimes(2));
    await act(async () => {
      newerPoll.resolve([{ ...schedule, cron: "0 11 * * 1-5", paused: true }]);
      await newerPoll.promise;
    });
    await waitFor(() =>
      expect(screen.getByText("0 11 * * 1-5")).toBeInTheDocument(),
    );
    await act(async () => {
      mutation.resolve({ ...schedule, cron: "0 10 * * 1-5" });
      await mutation.promise;
    });
    await waitFor(() => expect(updateLocalScheduleCron).toHaveBeenCalledOnce());
    expect(screen.getByText("0 11 * * 1-5")).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
    unmount();
  });

  it("cancels an edit without calling the scheduler", async () => {
    renderPanel();

    await screen.findByText("weekday-report");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Edit cron schedule for weekday-report",
      }),
    );
    const input = screen.getByLabelText("Cron expression for weekday-report");
    fireEvent.change(input, { target: { value: "0 10 * * 1-5" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(updateLocalScheduleCron).not.toHaveBeenCalled();
    expect(screen.getByText("0 9 * * 1-5")).toBeInTheDocument();
  });

  it("moves focus into and out of the cron editor", async () => {
    renderPanel();
    await screen.findByText("weekday-report");

    const editButton = screen.getByRole("button", {
      name: "Edit cron schedule for weekday-report",
    });
    fireEvent.click(editButton);
    const input = screen.getByLabelText("Cron expression for weekday-report");
    await waitFor(() => expect(input).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Edit cron schedule for weekday-report",
        }),
      ).toHaveFocus(),
    );
  });

  it("prevents unsupported cron edits from reaching Goose", async () => {
    renderPanel();

    await screen.findByText("weekday-report");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Edit cron schedule for weekday-report",
      }),
    );
    const input = screen.getByLabelText("Cron expression for weekday-report");
    fireEvent.change(input, { target: { value: "0 0 9 1 * MON" } });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Use a wildcard for month and a wildcard in either day-of-month or weekday",
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(updateLocalScheduleCron).not.toHaveBeenCalled();
  });

  it("surfaces a backend rejection and retains the user's draft", async () => {
    vi.mocked(listLocalSchedules)
      .mockResolvedValueOnce([schedule])
      .mockResolvedValueOnce([{ ...schedule, cron: "0 10 * * 1-5" }]);
    vi.mocked(updateLocalScheduleCron).mockRejectedValue({
      message: "Update failed",
      data: "schedule rejected",
    });
    renderPanel();

    await screen.findByText("weekday-report");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Edit cron schedule for weekday-report",
      }),
    );
    const input = screen.getByLabelText("Cron expression for weekday-report");
    fireEvent.change(input, { target: { value: "0 10 * * 1-5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("schedule rejected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    const retryInput = screen.getByLabelText(
      "Cron expression for weekday-report",
    );
    expect(retryInput).toHaveValue("0 10 * * 1-5");

    fireEvent.change(retryInput, { target: { value: "0 11 * * 1-5" } });
    fireEvent.change(retryInput, { target: { value: "0 10 * * 1-5" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(updateLocalScheduleCron).toHaveBeenCalledOnce();
  });

  it("allows an expression again after another update succeeds", async () => {
    vi.mocked(updateLocalScheduleCron)
      .mockRejectedValueOnce({
        message: "Update failed",
        data: "schedule rejected",
      })
      .mockResolvedValueOnce({ ...schedule, cron: "0 11 * * 1-5" });
    vi.mocked(listLocalSchedules)
      .mockResolvedValueOnce([schedule])
      .mockResolvedValueOnce([schedule])
      .mockResolvedValueOnce([{ ...schedule, cron: "0 11 * * 1-5" }]);
    renderPanel();

    await screen.findByText("weekday-report");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Edit cron schedule for weekday-report",
      }),
    );
    let input = screen.getByLabelText("Cron expression for weekday-report");
    fireEvent.change(input, { target: { value: "0 10 * * 1-5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("schedule rejected")).toBeInTheDocument();

    fireEvent.change(
      screen.getByLabelText("Cron expression for weekday-report"),
      { target: { value: "0 11 * * 1-5" } },
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updateLocalScheduleCron).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(screen.getByText("0 11 * * 1-5")).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Edit cron schedule for weekday-report",
      }),
    );
    input = screen.getByLabelText("Cron expression for weekday-report");
    fireEvent.change(input, { target: { value: "0 10 * * 1-5" } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
    );
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
