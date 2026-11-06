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
import {
  listLocalSchedules,
  updateLocalScheduleCron,
} from "@/features/automations/api/localSchedules";
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

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function renderPanel(queryClient = createQueryClient()) {
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
    await waitFor(() => expect(listLocalSchedules).toHaveBeenCalledTimes(2));
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

    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(
      expect.stringContaining("Use a wildcard for month"),
    );
    expect(
      screen.getByText(/^Use a wildcard for month/).closest('[role="status"]'),
    ).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText(/^Use a wildcard for month/)).toHaveTextContent(
      "Use a wildcard for month and a wildcard in either day-of-month or weekday",
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(updateLocalScheduleCron).not.toHaveBeenCalled();
  });

  it("does not mark an unchanged unsupported existing cron invalid without an error", async () => {
    vi.mocked(listLocalSchedules).mockResolvedValue([
      { ...schedule, cron: "0 0 1 1 *" },
    ]);
    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Edit cron schedule for weekday-report",
      }),
    );
    const input = screen.getByLabelText("Cron expression for weekday-report");
    expect(input).toHaveAttribute("aria-invalid", "false");
    expect(input).toHaveAttribute(
      "aria-describedby",
      "local-schedule-cron-help-weekday-report",
    );
    expect(
      screen.queryByText(/^Use a wildcard for month/),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("keeps timer uncertainty after reconciliation, cancel, navigation, and refresh until recovery succeeds", async () => {
    const reconciliation = deferred<(typeof schedule)[]>();
    const failed = { ...schedule, cron: "0 10 * * 1-5" };
    const recovered = { ...schedule, cron: "0 11 * * 1-5" };
    vi.mocked(listLocalSchedules)
      .mockResolvedValueOnce([schedule])
      .mockReturnValueOnce(reconciliation.promise)
      .mockResolvedValue([failed]);
    vi.mocked(updateLocalScheduleCron)
      .mockRejectedValueOnce(new Error("Timer replacement failed"))
      .mockResolvedValueOnce(recovered);
    const client = createQueryClient();
    const view = renderPanel(client);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Edit cron schedule for weekday-report",
      }),
    );
    let input = screen.getByLabelText("Cron expression for weekday-report");
    fireEvent.change(input, { target: { value: failed.cron } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("Timer replacement failed"),
    ).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(
      expect.stringContaining("Timer replacement failed"),
    );
    await waitFor(() => expect(listLocalSchedules).toHaveBeenCalledTimes(2));
    await act(async () => {
      reconciliation.resolve([failed]);
      await reconciliation.promise;
    });
    await waitFor(() =>
      expect(
        screen.queryByText("Checking the schedule's current state…"),
      ).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByText("Schedule timer needs verification"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Recover schedule for weekday-report",
      }),
    ).toBeInTheDocument();
    view.unmount();
    renderPanel(client);
    expect(
      await screen.findByText("Schedule timer needs verification"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled(),
    );
    const readsBeforeRefresh = vi.mocked(listLocalSchedules).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(listLocalSchedules).toHaveBeenCalledTimes(readsBeforeRefresh + 1),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Recover schedule for weekday-report",
      }),
    );
    input = screen.getByLabelText("Cron expression for weekday-report");
    expect(input).toHaveValue(failed.cron);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(input).toHaveAccessibleDescription(
      expect.stringContaining("This same expression already failed"),
    );
    fireEvent.change(input, { target: { value: recovered.cron } });
    expect(
      screen.getByText("Schedule timer needs verification"),
    ).toBeInTheDocument();
    vi.mocked(listLocalSchedules).mockResolvedValue([recovered]);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        screen.queryByLabelText("Cron expression for weekday-report"),
      ).not.toBeInTheDocument(),
    );
    expect(updateLocalScheduleCron).toHaveBeenNthCalledWith(
      2,
      schedule.id,
      recovered.cron,
    );
    expect(
      screen.queryByText("Schedule timer needs verification"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Edit cron schedule for weekday-report",
      }),
    ).toHaveFocus();
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

  it("waits for reconciliation before saving an alternate after rejection", async () => {
    vi.mocked(updateLocalScheduleCron)
      .mockRejectedValueOnce({
        message: "Update failed",
        data: "schedule rejected",
      })
      .mockResolvedValueOnce({ ...schedule, cron: "0 11 * * 1-5" });
    const reconciliation = deferred<(typeof schedule)[]>();
    vi.mocked(listLocalSchedules)
      .mockResolvedValueOnce([schedule])
      .mockReturnValueOnce(reconciliation.promise)
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
    await waitFor(() => expect(listLocalSchedules).toHaveBeenCalledTimes(2));

    fireEvent.change(
      screen.getByLabelText("Cron expression for weekday-report"),
      { target: { value: "0 11 * * 1-5" } },
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Save|Saving/ }),
      ).toBeDisabled(),
    );
    expect(
      screen.getByText("Checking the schedule's current state…"),
    ).toBeInTheDocument();
    expect(updateLocalScheduleCron).toHaveBeenCalledOnce();
    await act(async () => {
      reconciliation.resolve([{ ...schedule, cron: "0 10 * * 1-5" }]);
      await reconciliation.promise;
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updateLocalScheduleCron).toHaveBeenCalledTimes(2),
    );
    await waitFor(() => expect(listLocalSchedules).toHaveBeenCalledTimes(3));
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

  it("blocks overlapping updates after navigation while the previous save is pending", async () => {
    const pending = deferred<typeof schedule>();
    vi.mocked(updateLocalScheduleCron).mockReturnValueOnce(pending.promise);
    const client = createQueryClient();
    const view = renderPanel(client);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Edit cron schedule for weekday-report",
      }),
    );
    fireEvent.change(
      screen.getByLabelText("Cron expression for weekday-report"),
      { target: { value: "0 10 * * 1-5" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateLocalScheduleCron).toHaveBeenCalledOnce());
    view.unmount();
    renderPanel(client);
    const edit = await screen.findByRole("button", {
      name: "Edit cron schedule for weekday-report",
    });
    expect(edit).toBeDisabled();
    fireEvent.click(edit);
    expect(
      screen.queryByLabelText("Cron expression for weekday-report"),
    ).not.toBeInTheDocument();
    expect(updateLocalScheduleCron).toHaveBeenCalledOnce();
    await act(async () => {
      pending.resolve({ ...schedule, cron: "0 10 * * 1-5" });
      await pending.promise;
    });
    await waitFor(() => expect(edit).toBeEnabled());
  });

  it("does not let another row's older failure reconciliation overwrite a successful edit", async () => {
    const other = { ...schedule, id: "other-report" };
    const recoveredOther = { ...other, cron: "0 11 * * 1-5" };
    const reconciliation = deferred<(typeof schedule)[]>();
    let staleResponseDelivered = false;
    vi.mocked(listLocalSchedules)
      .mockResolvedValueOnce([schedule, other])
      .mockReturnValueOnce(
        reconciliation.promise.then((jobs) => {
          staleResponseDelivered = true;
          return jobs;
        }),
      )
      .mockResolvedValue([schedule, recoveredOther]);
    vi.mocked(updateLocalScheduleCron)
      .mockRejectedValueOnce(new Error("first update failed"))
      .mockResolvedValueOnce(recoveredOther);
    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Edit cron schedule for weekday-report",
      }),
    );
    fireEvent.change(
      screen.getByLabelText("Cron expression for weekday-report"),
      { target: { value: "0 10 * * 1-5" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("first update failed");
    await waitFor(() => expect(listLocalSchedules).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Edit cron schedule for other-report",
      }),
    );
    fireEvent.change(
      screen.getByLabelText("Cron expression for other-report"),
      { target: { value: recoveredOther.cron } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updateLocalScheduleCron).toHaveBeenNthCalledWith(
        2,
        other.id,
        recoveredOther.cron,
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByLabelText("Cron expression for other-report"),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText(recoveredOther.cron)).toBeInTheDocument();
    await act(async () => {
      reconciliation.resolve([schedule, other]);
      await reconciliation.promise;
    });
    expect(staleResponseDelivered).toBe(true);
    expect(screen.getByText(recoveredOther.cron)).toBeInTheDocument();
    expect(
      screen.getByText("Schedule timer needs verification"),
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
