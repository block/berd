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
              next_run_at_sec: 1714570000,
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

  it("reveals scheduled automation run metadata and payload", async () => {
    const user = userEvent.setup();

    renderBuilderbotView();

    await user.click(screen.getByRole("tab", { name: "Automations" }));
    await user.click(
      await screen.findByRole("button", { name: /daily-docs/i }),
    );

    expect(screen.getByText("Repeats")).toBeInTheDocument();
    expect(screen.getByText("Time zone")).toBeInTheDocument();
    expect(screen.getAllByText("Agent").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Run as Builderbot").length).toBeGreaterThan(0);
    expect(screen.queryByText("blox-vanilla")).not.toBeInTheDocument();
    expect(screen.getByText("success")).toBeInTheDocument();
    expect(screen.getByText("Summarize docs")).toBeInTheDocument();
  });

  it("updates the scheduled automation prompt through Builderbot", async () => {
    const user = userEvent.setup();

    renderBuilderbotView();

    await user.click(screen.getByRole("tab", { name: "Automations" }));
    await user.click(
      await screen.findByRole("button", { name: /daily-docs/i }),
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
      await screen.findByRole("button", { name: /daily-docs/i }),
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
      await screen.findByRole("button", { name: /daily-docs/i }),
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
      await screen.findByRole("button", { name: /daily-docs/i }),
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

  it("reveals routing automation source, conditions, and script payload", async () => {
    const user = userEvent.setup();

    renderBuilderbotView();

    await user.click(screen.getByRole("tab", { name: "Automations" }));
    await user.click(
      await screen.findByRole("button", { name: /repo-failure/i }),
    );

    expect(screen.getAllByText("GitHub").length).toBeGreaterThan(0);
    expect(screen.getByText("payload.branch equals main")).toBeInTheDocument();
    expect(screen.getAllByText("Script").length).toBeGreaterThan(0);
    expect(screen.queryByText("blox-repo-command")).not.toBeInTheDocument();
    expect(screen.getByText(/"command": "pnpm test"/)).toBeInTheDocument();
    expect(screen.queryByText("Owners")).not.toBeInTheDocument();
    expect(screen.queryByText("Created by")).not.toBeInTheDocument();
  });

  it("sends the full routing rule payload when changing run-as identity", async () => {
    const user = userEvent.setup();

    renderBuilderbotView();

    await user.click(screen.getByRole("tab", { name: "Automations" }));
    await user.click(
      await screen.findByRole("button", { name: /repo-failure/i }),
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
      await screen.findByRole("button", { name: /repo-failure/i }),
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
      await screen.findByRole("button", { name: /repo-failure/i }),
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
