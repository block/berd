import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/shared/i18n";
import { BuilderbotView } from "./BuilderbotView";

const builderbotApi = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => builderbotApi.invoke(...args),
}));

function renderBuilderbotView() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <BuilderbotView />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function mockBuilderbotResponses({
  updateError,
}: {
  updateError?: Error;
} = {}) {
  builderbotApi.invoke.mockImplementation((command: string) => {
    switch (command) {
      case "get_builderbot_tasks":
        return Promise.resolve({
          current_user: "morgan",
          tasks: [
            {
              key: "TASK-1",
              description:
                "Ship richer Builderbot details\n\nAdd read-only metadata.",
              status: "TASK_STATUS_IN_PROGRESS",
              author: "morgan",
              assignee: "builderbot",
              latest_actor: "casey",
              created_at_ms: 1714568400000,
              updated_at_ms: 1714568500000,
              labels: ["builderbot", "ux"],
              artifacts_count: 2,
              artifacts_url:
                "https://builderbot.sqprod.co/tasks/TASK-1/artifacts",
              thread_url: "https://builderbot.sqprod.co/threads/thread-1",
            },
            {
              key: "TASK-2",
              description: "Publish the Builderbot card polish",
              status: "TASK_STATUS_COMPLETED",
              author: "morgan",
              updated_at_ms: 1714568500000,
              labels: ["design"],
            },
            {
              key: "TASK-3",
              description: "Archive stale Builderbot experiment",
              status: "TASK_STATUS_CANCELLED",
              author: "morgan",
              updated_at_ms: 1714568500000,
              labels: ["cleanup"],
            },
            {
              key: "TASK-4",
              description: "Queue Builderbot follow-up",
              status: "TASK_STATUS_PENDING",
              author: "morgan",
              updated_at_ms: 1714568500000,
              labels: ["follow-up"],
            },
          ],
        });
      case "get_builderbot_scheduled_triggers":
        return Promise.resolve({
          current_user: "morgan",
          triggers: [
            {
              reference: "daily-docs",
              enabled: true,
              cron_expression: "0 9 * * 1-5",
              next_run_at_sec: Math.floor(
                (Date.now() + 7 * 60 * 60 * 1000) / 1000,
              ),
              last_run_at_sec: 1714560000,
              last_status: "TRIGGER_RUN_STATUS_SUCCESS",
              updated_at_ms: 1714568500000,
              created_by: "morgan",
              owners: ["morgan"],
              routine: {
                routine_identifier: "blox-vanilla",
                input_payload: '{"prompt":"Summarize docs"}',
                run_as_service: "builderbot",
              },
            },
            {
              reference: "quiet-docs",
              enabled: true,
              cron_expression: "0 11 * * 1-5",
              next_run_at_sec: Math.floor(
                (Date.now() + 9 * 60 * 60 * 1000) / 1000,
              ),
              last_run_at_sec: 1714560000,
              last_status: "TRIGGER_RUN_STATUS_UNSPECIFIED",
              updated_at_ms: 1714568500000,
              created_by: "morgan",
              owners: ["morgan"],
              routine: {
                routine_identifier: "blox-vanilla",
                input_payload: '{"prompt":"Stay quiet"}',
                run_as_service: "builderbot",
              },
            },
          ],
        });
      case "get_builderbot_routing_rules":
        return Promise.resolve({
          current_user: "morgan",
          rules: [
            {
              reference: "repo-failure",
              source: "github",
              enabled: false,
              updated_at_ms: 1714568600000,
              created_by: "morgan",
              owner: "morgan",
              owners: ["morgan", "design"],
              conditions: [
                {
                  path: "payload.branch",
                  operator: "equals",
                  value: "main",
                },
              ],
              routine: {
                routine_identifier: "blox-repo-command",
                input_payload: '{"command":"pnpm test"}',
                run_as_service: "builderbot",
              },
            },
            {
              reference: "linear-active",
              source: "linear",
              enabled: true,
              updated_at_ms: 1714568700000,
              created_by: "morgan",
              owner: "morgan",
              owners: ["morgan"],
              conditions: [],
              routine: {
                routine_identifier: "blox-vanilla",
                input_payload: '{"prompt":"Watch Linear"}',
              },
            },
          ],
        });
      case "update_builderbot_scheduled_trigger":
      case "update_builderbot_routing_rule":
        return updateError ? Promise.reject(updateError) : Promise.resolve({});
      default:
        return Promise.resolve({});
    }
  });
}

describe("BuilderbotView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (!HTMLElement.prototype.hasPointerCapture) {
      Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
        value: () => false,
      });
    }
    if (!HTMLElement.prototype.setPointerCapture) {
      Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
        value: () => undefined,
      });
    }
    if (!HTMLElement.prototype.releasePointerCapture) {
      Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
        value: () => undefined,
      });
    }
    if (!HTMLElement.prototype.scrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        value: () => undefined,
      });
    }
    mockBuilderbotResponses();
  });

  it("reveals read-only task details from the task payload", async () => {
    const user = userEvent.setup();

    renderBuilderbotView();

    await user.click(
      await screen.findByRole("button", {
        name: /Ship richer Builderbot details/i,
      }),
    );

    expect(screen.getAllByText("TASK-1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("in progress").length).toBeGreaterThan(0);
    expect(screen.getByText("casey")).toBeInTheDocument();
    expect(screen.getAllByText("builderbot").length).toBeGreaterThan(0);
    expect(screen.getAllByText("ux").length).toBeGreaterThan(0);
    expect(
      screen.getByText("Add read-only metadata.", { exact: false }),
    ).toBeInTheDocument();

    expect(
      screen.getByRole("button", { name: /Open 2 artifacts/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Open thread/i }),
    ).toBeInTheDocument();
  });

  it("keeps task overview cards focused on status and timing", async () => {
    renderBuilderbotView();

    const row = await screen.findByRole("button", {
      name: /Ship richer Builderbot details/i,
    });

    expect(row).not.toHaveTextContent("TASK-1");
    expect(row).not.toHaveTextContent("by morgan");
    expect(row).not.toHaveTextContent("builderbot");
    expect(row).not.toHaveTextContent("ux");
    expect(row).not.toHaveTextContent("in progress");
    expect(screen.queryByText("in progress")).not.toBeInTheDocument();
    expect(screen.queryByText("completed")).not.toBeInTheDocument();
    expect(screen.queryByText("cancelled")).not.toBeInTheDocument();
    expect(screen.queryByText("pending")).not.toBeInTheDocument();
  });

  it("reveals scheduled automation run metadata and payload", async () => {
    const user = userEvent.setup();

    renderBuilderbotView();

    await user.click(screen.getByRole("tab", { name: "Automations" }));
    await user.click(
      await screen.findByRole("button", { name: /Daily docs/i }),
    );

    expect(screen.getByText("Repeats")).toBeInTheDocument();
    expect(screen.getByText("Time zone")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getAllByText("Agent").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Run as Builderbot").length).toBeGreaterThan(0);
    expect(screen.queryByText("blox-vanilla")).not.toBeInTheDocument();
    expect(screen.getByLabelText("success")).toBeInTheDocument();
    expect(screen.queryByText("success")).not.toBeInTheDocument();
    expect(screen.queryByText("Run metadata")).not.toBeInTheDocument();
    expect(screen.getByText("Summarize docs")).toBeInTheDocument();
  });

  it("does not render a failure icon for unspecified scheduled run status", async () => {
    const user = userEvent.setup();

    renderBuilderbotView();

    await user.click(screen.getByRole("tab", { name: "Automations" }));
    await user.click(
      await screen.findByRole("button", { name: /Quiet docs/i }),
    );

    expect(screen.getByText("Stay quiet")).toBeInTheDocument();
    expect(screen.queryByLabelText("unspecified")).not.toBeInTheDocument();
  });

  it("explains read-only scheduled automation fields with value-specific tooltips", async () => {
    const user = userEvent.setup();

    renderBuilderbotView();

    await user.click(screen.getByRole("tab", { name: "Automations" }));
    await user.click(
      await screen.findByRole("button", { name: /Daily docs/i }),
    );

    await user.hover(screen.getByRole("button", { name: "Explain name" }));
    expect(
      (await screen.findAllByText(/automation's unique name/i)).length,
    ).toBeGreaterThan(0);

    await user.hover(
      screen.getByRole("button", { name: "Explain trigger type" }),
    );
    expect(
      (
        await screen.findAllByText(
          /Scheduled automations run at a time you choose/i,
        )
      ).length,
    ).toBeGreaterThan(0);

    await user.hover(
      screen.getByRole("button", { name: "Explain action type" }),
    );
    expect(
      (
        await screen.findAllByText(
          /Agent automations run non-deterministically through an agent/i,
        )
      ).length,
    ).toBeGreaterThan(0);
  });

  it("keeps automation overview cards focused on status and trigger", async () => {
    const user = userEvent.setup();

    renderBuilderbotView();

    await user.click(screen.getByRole("tab", { name: "Automations" }));

    expect(
      await screen.findByRole("button", { name: /Daily docs/i }),
    ).toHaveTextContent("Weekdays at");
    expect(screen.getByText("Daily docs")).toBeInTheDocument();
    expect(screen.queryByText("daily-docs")).not.toBeInTheDocument();
    expect(screen.getByText("Next in 7 hours")).toBeInTheDocument();
    expect(screen.queryByText("0 9 * * 1-5")).not.toBeInTheDocument();
    expect(screen.queryByText(/hr\\./i)).not.toBeInTheDocument();
    expect(screen.queryByText("1 condition")).not.toBeInTheDocument();
    expect(screen.queryByText("Run as Builderbot")).not.toBeInTheDocument();
    expect(screen.queryByText("Script")).not.toBeInTheDocument();
    expect(screen.queryByText("Disabled")).not.toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.queryByText("Listening")).not.toBeInTheDocument();
  });

  it("updates the scheduled automation prompt through Builderbot", async () => {
    const user = userEvent.setup();

    renderBuilderbotView();

    await user.click(screen.getByRole("tab", { name: "Automations" }));
    await user.click(
      await screen.findByRole("button", { name: /Daily docs/i }),
    );
    await user.click(
      screen.getByRole("button", { name: "Edit prompt or payload" }),
    );

    const prompt = screen.getByRole("textbox", { name: "Prompt" });
    await user.clear(prompt);
    await user.type(prompt, "Write a better joke");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(builderbotApi.invoke).toHaveBeenCalledWith(
      "update_builderbot_scheduled_trigger",
      {
        reference: "daily-docs",
        request: {
          reference: "daily-docs",
          enabled: true,
          cron_expression: "0 9 * * 1-5",
          routine: {
            routine_identifier: "blox-vanilla",
            input_payload: '{"prompt":"Write a better joke"}',
            run_as_service: "builderbot",
          },
          owners: ["morgan"],
        },
      },
    );
  });

  it("keeps prompt edits open when Builderbot rejects the update", async () => {
    const user = userEvent.setup();
    mockBuilderbotResponses({
      updateError: new Error("Builderbot rejected the update"),
    });

    renderBuilderbotView();

    await user.click(screen.getByRole("tab", { name: "Automations" }));
    await user.click(
      await screen.findByRole("button", { name: /Daily docs/i }),
    );
    await user.click(
      screen.getByRole("button", { name: "Edit prompt or payload" }),
    );

    const prompt = screen.getByRole("textbox", { name: "Prompt" });
    await user.clear(prompt);
    await user.type(prompt, "Write a better joke");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText("Builderbot rejected the update"),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue(
      "Write a better joke",
    );
  });

  it("does not offer an unsupported no-schedule option for Builderbot triggers", async () => {
    const user = userEvent.setup();

    renderBuilderbotView();

    await user.click(screen.getByRole("tab", { name: "Automations" }));
    await user.click(
      await screen.findByRole("button", { name: /Daily docs/i }),
    );
    await user.click(screen.getByRole("combobox", { name: "Repeats" }));

    expect(
      screen.queryByRole("option", { name: "No schedule" }),
    ).not.toBeInTheDocument();
  });

  it("sends the full scheduled trigger payload when toggling enabled state", async () => {
    const user = userEvent.setup();

    renderBuilderbotView();

    await user.click(screen.getByRole("tab", { name: "Automations" }));
    await user.click(
      await screen.findByRole("button", { name: /Daily docs/i }),
    );
    await user.click(screen.getByRole("switch", { name: "Status" }));

    expect(builderbotApi.invoke).toHaveBeenCalledWith(
      "update_builderbot_scheduled_trigger",
      {
        reference: "daily-docs",
        request: {
          reference: "daily-docs",
          enabled: false,
          cron_expression: "0 9 * * 1-5",
          routine: {
            routine_identifier: "blox-vanilla",
            input_payload: '{"prompt":"Summarize docs"}',
            run_as_service: "builderbot",
          },
          owners: ["morgan"],
        },
      },
    );
  });

  it("reveals routing automation config and script payload without run metadata", async () => {
    const user = userEvent.setup();

    renderBuilderbotView();

    await user.click(screen.getByRole("tab", { name: "Automations" }));
    await user.click(
      await screen.findByRole("button", { name: /Repo failure/i }),
    );

    expect(screen.getAllByText("GitHub").length).toBeGreaterThan(0);
    expect(
      screen.queryByText("payload.branch equals main"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Last run")).not.toBeInTheDocument();
    expect(screen.queryByText("Next run")).not.toBeInTheDocument();
    expect(screen.getAllByText("Script").length).toBeGreaterThan(0);
    expect(screen.queryByText("blox-repo-command")).not.toBeInTheDocument();
    expect(screen.getByText(/"command": "pnpm test"/)).toBeInTheDocument();
    expect(screen.queryByText("Owners")).not.toBeInTheDocument();
    expect(screen.queryByText("Created by")).not.toBeInTheDocument();
  });

  it("explains triggered script automation fields with value-specific tooltips", async () => {
    const user = userEvent.setup();

    renderBuilderbotView();

    await user.click(screen.getByRole("tab", { name: "Automations" }));
    await user.click(
      await screen.findByRole("button", { name: /Repo failure/i }),
    );

    await user.hover(
      screen.getByRole("button", { name: "Explain trigger type" }),
    );
    expect(
      (
        await screen.findAllByText(
          /Triggered automations run when something happens in another tool/i,
        )
      ).length,
    ).toBeGreaterThan(0);

    await user.hover(screen.getByRole("button", { name: "Explain source" }));
    expect(
      (
        await screen.findAllByText(
          /Source is the tool that sends events to this automation/i,
        )
      ).length,
    ).toBeGreaterThan(0);

    await user.hover(
      screen.getByRole("button", { name: "Explain action type" }),
    );
    expect(
      (await screen.findAllByText(/Script automations run a defined command/i))
        .length,
    ).toBeGreaterThan(0);
  });

  it("sends the full routing rule payload when changing run-as identity", async () => {
    const user = userEvent.setup();

    renderBuilderbotView();

    await user.click(screen.getByRole("tab", { name: "Automations" }));
    await user.click(
      await screen.findByRole("button", { name: /Repo failure/i }),
    );
    await user.click(screen.getByRole("combobox", { name: "Run as" }));
    await user.click(await screen.findByRole("option", { name: "Run as me" }));

    await waitFor(() => {
      expect(builderbotApi.invoke).toHaveBeenCalledWith(
        "update_builderbot_routing_rule",
        {
          reference: "repo-failure",
          request: {
            reference: "repo-failure",
            enabled: false,
            source: "github",
            conditions: [
              {
                path: "payload.branch",
                operator: "equals",
                value: "main",
              },
            ],
            outcome_labels: [],
            routine: {
              routine_identifier: "blox-repo-command",
              input_payload: '{"command":"pnpm test"}',
            },
            owners: ["morgan", "design"],
          },
        },
      );
    });
  });

  it("sends the full routing rule payload when toggling enabled state", async () => {
    const user = userEvent.setup();

    renderBuilderbotView();

    await user.click(screen.getByRole("tab", { name: "Automations" }));
    await user.click(
      await screen.findByRole("button", { name: /Repo failure/i }),
    );
    await user.click(screen.getByRole("switch", { name: "Status" }));

    await waitFor(() => {
      expect(builderbotApi.invoke).toHaveBeenCalledWith(
        "update_builderbot_routing_rule",
        {
          reference: "repo-failure",
          request: {
            reference: "repo-failure",
            enabled: true,
            source: "github",
            conditions: [
              {
                path: "payload.branch",
                operator: "equals",
                value: "main",
              },
            ],
            outcome_labels: [],
            routine: {
              routine_identifier: "blox-repo-command",
              input_payload: '{"command":"pnpm test"}',
              run_as_service: "builderbot",
            },
            owners: ["morgan", "design"],
          },
        },
      );
    });
  });

  it("updates the routing automation payload through Builderbot", async () => {
    const user = userEvent.setup();

    renderBuilderbotView();

    await user.click(screen.getByRole("tab", { name: "Automations" }));
    await user.click(
      await screen.findByRole("button", { name: /Repo failure/i }),
    );
    await user.click(
      screen.getByRole("button", { name: "Edit prompt or payload" }),
    );

    const payload = screen.getByRole("textbox", { name: "Prompt or payload" });
    fireEvent.change(payload, {
      target: { value: '{"command":"pnpm lint"}' },
    });
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(builderbotApi.invoke).toHaveBeenCalledWith(
        "update_builderbot_routing_rule",
        {
          reference: "repo-failure",
          request: {
            reference: "repo-failure",
            enabled: false,
            source: "github",
            conditions: [
              {
                path: "payload.branch",
                operator: "equals",
                value: "main",
              },
            ],
            outcome_labels: [],
            routine: {
              routine_identifier: "blox-repo-command",
              input_payload: '{"command":"pnpm lint"}',
              run_as_service: "builderbot",
            },
            owners: ["morgan", "design"],
          },
        },
      );
    });
  });
});
