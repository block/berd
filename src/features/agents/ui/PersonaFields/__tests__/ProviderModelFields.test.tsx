import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OPEN_SETTINGS_EVENT } from "@/features/settings/lib/settingsEvents";
import { renderWithProviders } from "@/test/render";
import { ProviderModelFields } from "../ProviderModelFields";

if (!HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
}

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
}

const mocks = vi.hoisted(() => ({
  acpProviders: [
    { id: "goose", label: "Goose" },
    { id: "claude-acp", label: "Claude Code" },
    { id: "codex-acp", label: "Codex" },
  ],
  agentReadiness: new Map<string, "ready" | "not_ready" | "not_installed">(),
  getModelsForAgent: vi.fn(),
  getError: vi.fn(),
}));

vi.mock("@/features/agents/stores/agentStore", () => ({
  useAgentStore: (selector: (state: { providers: unknown[] }) => unknown) =>
    selector({ providers: mocks.acpProviders }),
}));

vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => ({
    readyAgentIds: new Set(
      [...mocks.agentReadiness.entries()]
        .filter(([, readiness]) => readiness === "ready")
        .map(([id]) => id),
    ),
    agentReadiness: mocks.agentReadiness,
    loading: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/features/providers/hooks/useProviderModels", () => ({
  useProviderModels: () => ({
    getModelsForAgent: mocks.getModelsForAgent,
    getError: mocks.getError,
  }),
}));

function renderFields(
  overrides: Partial<Parameters<typeof ProviderModelFields>[0]> = {},
) {
  const props = {
    provider: "",
    model: "",
    onProviderChange: vi.fn(),
    onModelChange: vi.fn(),
    ...overrides,
  };

  renderWithProviders(<ProviderModelFields {...props} />);
  return props;
}

describe("ProviderModelFields", () => {
  beforeEach(() => {
    mocks.agentReadiness = new Map([
      ["goose", "ready"],
      ["claude-acp", "not_ready"],
      ["codex-acp", "not_installed"],
    ]);
    mocks.getModelsForAgent.mockReset();
    mocks.getModelsForAgent.mockReturnValue([]);
    mocks.getError.mockReset();
    mocks.getError.mockReturnValue(null);
  });

  it("selects a ready provider", async () => {
    const user = userEvent.setup();
    const props = renderFields({ model: "old-model" });

    await user.click(screen.getAllByRole("combobox")[0]);
    await user.click(await screen.findByRole("option", { name: "Goose" }));

    expect(props.onProviderChange).toHaveBeenCalledWith("goose");
  });

  it("keeps the concrete provider when model ids overlap", async () => {
    mocks.getModelsForAgent.mockReturnValue([
      {
        id: "shared-model",
        name: "Shared OpenAI model",
        providerId: "openai",
      },
      {
        id: "shared-model",
        name: "Shared Databricks model",
        providerId: "databricks_v2",
      },
    ]);
    const user = userEvent.setup();
    const props = renderFields({ provider: "goose" });

    await user.click(screen.getAllByRole("combobox")[1]);
    await user.click(
      await screen.findByRole("option", { name: "Shared Databricks model" }),
    );

    expect(props.onModelChange).toHaveBeenCalledWith({
      modelId: "shared-model",
      modelProviderId: "databricks_v2",
    });
  });

  it("routes unconnected providers to AI Providers settings without selecting them", async () => {
    const user = userEvent.setup();
    const props = renderFields();
    const settingsEvents: CustomEvent[] = [];
    const onOpenSettings = (event: Event) => {
      settingsEvents.push(event as CustomEvent);
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpenSettings);

    await user.click(screen.getAllByRole("combobox")[0]);
    await user.click(
      await screen.findByRole("option", { name: /Claude Code/ }),
    );

    window.removeEventListener(OPEN_SETTINGS_EVENT, onOpenSettings);

    expect(props.onProviderChange).not.toHaveBeenCalled();
    expect(props.onModelChange).not.toHaveBeenCalled();
    expect(settingsEvents).toHaveLength(1);
    expect(settingsEvents[0].detail).toEqual({ section: "providers" });
  });

  it("includes the builder session as setup return context", async () => {
    const user = userEvent.setup();
    renderFields({ builderSessionId: "session-1" });
    const settingsEvents: CustomEvent[] = [];
    const onOpenSettings = (event: Event) => {
      settingsEvents.push(event as CustomEvent);
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpenSettings);

    await user.click(screen.getAllByRole("combobox")[0]);
    await user.click(
      await screen.findByRole("option", { name: /Claude Code/ }),
    );

    window.removeEventListener(OPEN_SETTINGS_EVENT, onOpenSettings);

    expect(settingsEvents[0].detail).toEqual({
      section: "providers",
      returnTarget: {
        type: "agent-builder-provider-setup",
        sessionId: "session-1",
        providerId: "claude-acp",
      },
    });
  });

  it("blocks model selection when the saved provider is no longer ready", () => {
    renderFields({ provider: "claude-acp" });

    expect(screen.getAllByRole("combobox")[1]).toBeDisabled();
    expect(
      screen.getByText("This provider isn't connected yet."),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Set it up in AI Providers." }),
    ).toBeVisible();
  });
});
