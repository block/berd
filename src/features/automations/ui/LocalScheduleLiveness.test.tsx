import {
  QueryClient,
  QueryClientProvider,
  notifyManager,
} from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_SCHEDULE_READ_TIMEOUT_MS,
  LOCAL_SCHEDULE_UPDATE_TIMEOUT_MS,
  updateLocalScheduleCron,
} from "@/features/automations/api/localSchedules";
import { getBackendConnection } from "@/shared/api/acpConnection";
import { LocalSchedulesPanel } from "@/features/automations/ui/LocalSchedulesPanel";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  list: vi.fn(),
  stream: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));
vi.mock("@/shared/api/createWebSocketStream", () => ({
  createWebSocketStream: () => mocks.stream(),
}));
vi.mock("@agentclientprotocol/sdk", () => ({ PROTOCOL_VERSION: 1 }));
vi.mock("@aaif/goose-sdk", () => ({
  DEFAULT_GOOSE_MCP_HOST_CAPABILITIES: {},
  GooseClient: class {
    initialize = vi.fn().mockResolvedValue(undefined);
    closed = new Promise<void>(() => {});
    goose = {
      GooseUnstableSchedulesList: mocks.list,
      GooseUnstableSchedulesUpdate: mocks.update,
    };
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const schedule = {
  id: "weekday-report",
  source: "/tmp/weekday-report.yaml",
  cron: "0 9 * * 1-5",
  paused: false,
  currentlyRunning: false,
};
const failed = { ...schedule, cron: "0 10 * * 1-5" };
const recovered = { ...schedule, cron: "0 11 * * 1-5" };
let client: QueryClient;
let views: Array<ReturnType<typeof render>>;
function mount() {
  const view = render(
    <QueryClientProvider client={client}>
      <LocalSchedulesPanel />
    </QueryClientProvider>,
  );
  views.push(view);
  return view;
}
async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function edit(cron: string, recovery = false) {
  fireEvent.click(
    screen.getByRole("button", {
      name: `${recovery ? "Recover schedule" : "Edit cron schedule"} for weekday-report`,
    }),
  );
  fireEvent.change(
    screen.getByLabelText("Cron expression for weekday-report"),
    { target: { value: cron } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

beforeEach(async () => {
  vi.useFakeTimers();
  notifyManager.setScheduler((callback) => callback());
  mocks.update.mockReset();
  mocks.list.mockReset();
  mocks.stream.mockReset();
  mocks.invoke.mockReset();
  void getBackendConnection("local").invalidate();
  mocks.invoke.mockResolvedValue("ws://local");
  mocks.stream.mockImplementation(() => ({
    writable: { abort: vi.fn().mockResolvedValue(undefined) },
  }));
  mocks.list.mockResolvedValue({ jobs: [schedule] });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });
  views = [];
});
afterEach(async () => {
  views.forEach((view) => {
    view.unmount();
  });
  client.clear();
  void getBackendConnection("local").invalidate();
  notifyManager.setScheduler((callback) => setTimeout(callback, 0));
  vi.useRealTimers();
});

describe("schedule request liveness through the real connection generation", () => {
  it.each([
    "success",
    "error",
  ] as const)("releases a remounted lock after timeout and fences late %s during fresh recovery", async (late) => {
    const old = deferred<{ job: typeof schedule }>();
    const replacement = deferred<{ job: typeof schedule }>();
    mocks.update
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(replacement.promise);
    const firstView = mount();
    await tick();
    edit(failed.cron);
    await tick();
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
      scheduleId: schedule.id,
      cron: failed.cron,
    });
    const connection = getBackendConnection("local");
    const oldClient = connection.getClientSync();
    mocks.list.mockReturnValueOnce(new Promise(() => {}));
    const oldStream = mocks.stream.mock.results[0].value;
    oldStream.writable.abort.mockReturnValue(new Promise(() => {}));
    firstView.unmount();
    mount();
    await tick();
    expect(
      screen.getByRole("button", {
        name: "Edit cron schedule for weekday-report",
      }),
    ).toBeDisabled();
    expect(client.isMutating()).toBe(1);
    await tick(LOCAL_SCHEDULE_UPDATE_TIMEOUT_MS);
    expect(client.isMutating()).toBe(0);
    expect(oldStream.writable.abort).toHaveBeenCalledOnce();
    expect(connection.getClientSync()).not.toBe(oldClient);
    expect(
      screen.getByText("Schedule timer needs verification"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Recover schedule for weekday-report",
      }),
    ).toBeEnabled();
    edit(recovered.cron, true);
    await tick();
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(mocks.stream).toHaveBeenCalledTimes(2);
    const newClient = connection.getClientSync();
    expect(client.isMutating()).toBe(1);
    replacement.reject(new Error("new rejection"));
    await tick();
    expect(client.isMutating()).toBe(0);
    expect(
      client.getQueryData(["local-goose-schedule-failures", schedule.id]),
    ).toEqual([failed.cron, recovered.cron]);
    await act(async () => {
      if (late === "success") old.resolve({ job: failed });
      else old.reject(new Error("old rejection"));
      await old.promise.catch(() => {});
    });
    await tick();
    expect(client.isMutating()).toBe(0);
    expect(
      client.getQueryData<Array<typeof schedule>>([
        "local-goose-schedules",
      ])?.[0].cron,
    ).toBe(schedule.cron);
    expect(
      client.getQueryData(["local-goose-schedule-failures", schedule.id]),
    ).toEqual([failed.cron, recovered.cron]);
    expect(
      screen.getByText("Schedule timer needs verification"),
    ).toBeInTheDocument();
    expect(connection.getClientSync()).toBe(newClient);
  });

  it("releases the open editor at its deadline with an accessible uncertainty error", async () => {
    mocks.update.mockReturnValue(new Promise(() => {}));
    mount();
    await tick();
    edit(failed.cron);
    await tick();
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(
      screen.getByLabelText("Cron expression for weekday-report"),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await tick(LOCAL_SCHEDULE_UPDATE_TIMEOUT_MS);
    const input = screen.getByLabelText("Cron expression for weekday-report");
    expect(client.isMutating()).toBe(0);
    expect(input).toBeEnabled();
    expect(input).toHaveAccessibleDescription(
      expect.stringContaining("The schedule update timed out"),
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(
      screen.getByText("Schedule timer needs verification"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByRole("button", {
        name: "Recover schedule for weekday-report",
      }),
    ).toBeEnabled();
    expect(
      screen.getByText("Schedule timer needs verification"),
    ).toBeInTheDocument();
  });

  it("does not let an older timeout detach a newer replacement transport", async () => {
    mocks.update.mockReturnValue(new Promise(() => {}));
    const first = updateLocalScheduleCron("first", failed.cron);
    const firstRejected = expect(first).rejects.toMatchObject({
      code: "updateTimeout",
    });
    await tick(10_000);
    const second = updateLocalScheduleCron("second", recovered.cron);
    const secondRejected = expect(second).rejects.toMatchObject({
      code: "updateTimeout",
    });
    await tick();
    expect(mocks.update).toHaveBeenCalledTimes(2);
    await tick(50_000);
    await firstRejected;
    const connection = getBackendConnection("local");
    expect(connection.getClientSync()).toBeNull();
    const fresh = await connection.getClient();
    const freshStream = mocks.stream.mock.results[1].value;
    await tick(10_000);
    await secondRejected;
    expect(connection.getClientSync()).toBe(fresh);
    expect(freshStream.writable.abort).not.toHaveBeenCalled();
  });

  it("does not send an update if client acquisition finishes after its deadline", async () => {
    const endpoint = deferred<string>();
    mocks.invoke.mockReturnValueOnce(endpoint.promise);
    const pending = updateLocalScheduleCron(schedule.id, failed.cron);
    const rejected = expect(pending).rejects.toMatchObject({
      code: "updateTimeout",
    });
    expect(mocks.invoke).toHaveBeenCalledOnce();
    await tick(LOCAL_SCHEDULE_UPDATE_TIMEOUT_MS);
    await rejected;
    endpoint.resolve("ws://old");
    await tick();
    expect(mocks.update).not.toHaveBeenCalled();
    await getBackendConnection("local").getClient();
    expect(mocks.stream).toHaveBeenCalledOnce();
  });

  it("finishes confirmed success before a stalled readback and makes refresh recoverable", async () => {
    const readback = deferred<{ jobs: (typeof schedule)[] }>();
    mocks.update.mockResolvedValue({ job: recovered });
    mocks.list
      .mockResolvedValueOnce({ jobs: [schedule] })
      .mockReturnValueOnce(readback.promise)
      .mockResolvedValue({ jobs: [recovered] });
    mount();
    await tick();
    edit(recovered.cron);
    await tick();
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(client.isMutating()).toBe(0);
    expect(
      screen.queryByLabelText("Cron expression for weekday-report"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Schedule timer needs verification"),
    ).not.toBeInTheDocument();
    await tick(LOCAL_SCHEDULE_READ_TIMEOUT_MS);
    expect(screen.getByText(/Schedule refresh timed out/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await tick();
    expect(mocks.list).toHaveBeenCalledTimes(3);
    expect(screen.getByText(recovered.cron)).toBeInTheDocument();
    readback.resolve({ jobs: [failed] });
    await tick();
    expect(screen.getByText(recovered.cron)).toBeInTheDocument();
    expect(
      screen.queryByText(/Schedule refresh timed out/),
    ).not.toBeInTheDocument();
  });

  it("bounds stalled failure reconciliation without losing uncertainty", async () => {
    mocks.update.mockRejectedValue(new Error("replacement rejected"));
    mocks.list
      .mockResolvedValueOnce({ jobs: [schedule] })
      .mockReturnValueOnce(new Promise(() => {}));
    mount();
    await tick();
    edit(failed.cron);
    await tick();
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(client.isMutating()).toBe(1);
    await tick(LOCAL_SCHEDULE_READ_TIMEOUT_MS);
    expect(client.isMutating()).toBe(0);
    expect(screen.getByText(/The refresh also failed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByText("Schedule timer needs verification"),
    ).toBeInTheDocument();
  });

  it("handles rejection before the deadline and ordinary success without retiring transport", async () => {
    mocks.update
      .mockRejectedValueOnce(new Error("replacement rejected"))
      .mockResolvedValueOnce({ job: recovered });
    mount();
    await tick();
    edit(failed.cron);
    await tick();
    expect(screen.getByText("replacement rejected")).toBeInTheDocument();
    expect(client.isMutating()).toBe(0);
    const stream = mocks.stream.mock.results[0].value;
    fireEvent.change(
      screen.getByLabelText("Cron expression for weekday-report"),
      { target: { value: recovered.cron } },
    );
    mocks.list.mockResolvedValue({ jobs: [recovered] });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await tick();
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(client.isMutating()).toBe(0);
    expect(
      screen.queryByText("Schedule timer needs verification"),
    ).not.toBeInTheDocument();
    await tick(LOCAL_SCHEDULE_UPDATE_TIMEOUT_MS);
    expect(stream.writable.abort).not.toHaveBeenCalled();
  });

  it("rejects a response from a generation replaced before its deadline", async () => {
    const response = deferred<{ job: typeof schedule }>();
    mocks.update.mockReturnValue(response.promise);
    const pending = updateLocalScheduleCron(schedule.id, failed.cron);
    const rejected = expect(pending).rejects.toMatchObject({
      code: "connectionChanged",
    });
    await tick();
    expect(mocks.update).toHaveBeenCalledOnce();
    void getBackendConnection("local").invalidate();
    await getBackendConnection("local").getClient();
    response.resolve({ job: failed });
    await rejected;
  });
});
