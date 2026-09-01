import type { ComponentProps } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentModelPicker } from "../AgentModelPicker";
import {
  getModelRecencyMap,
  getModelRecencyRank,
  MODEL_RECENCY_STORAGE_KEY,
  recordModelSelection,
} from "../../lib/modelRecency";
import { OPEN_SETTINGS_EVENT } from "@/features/settings/lib/settingsEvents";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver ??=
  ResizeObserverStub as unknown as typeof ResizeObserver;

const AGENTS = [
  { id: "goose", label: "Goose" },
  { id: "claude-acp", label: "Claude Code" },
  { id: "codex-acp", label: "Codex" },
];

describe("AgentModelPicker", () => {
  // Model selection persists recency to localStorage; keep tests isolated.
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    getModelRecencyMap();
  });

  it("shows the selected agent and model in the trigger", () => {
    render(
      <AgentModelPicker
        agents={AGENTS}
        selectedAgentId="goose"
        onAgentChange={vi.fn()}
        currentModelId="gpt-4o"
        currentModelName="GPT-4o"
        availableModels={[{ id: "gpt-4o", name: "GPT-4o" }]}
        onModelChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: /choose agent and model/i }),
    ).toHaveTextContent("GPT-4o");
  });

  it("routes not-ready Goose to Providers settings with a connect action", async () => {
    const user = userEvent.setup();
    const onAgentChange = vi.fn();
    const onRequestComposerFocus = vi.fn();
    const settingsDestination = document.createElement("button");
    document.body.appendChild(settingsDestination);
    const openSettings = vi.fn(() => settingsDestination.focus());
    window.addEventListener(OPEN_SETTINGS_EVENT, openSettings);

    render(
      <AgentModelPicker
        agents={[
          {
            id: "goose",
            label: "Goose",
            readiness: "not_ready",
            setupAction: "connect",
          },
          { id: "codex-acp", label: "Codex", readiness: "ready" },
        ]}
        selectedAgentId="goose"
        onAgentChange={onAgentChange}
        availableModels={[]}
        onModelChange={vi.fn()}
        onRequestComposerFocus={onRequestComposerFocus}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /choose agent and model/i }),
    );

    const goose = screen.getByRole("button", { name: /goose/i });
    expect(goose).toHaveTextContent("Connect");
    expect(goose).not.toHaveTextContent("Install");

    await user.click(goose);

    expect(onAgentChange).not.toHaveBeenCalled();
    expect(openSettings).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { section: "providers" } }),
    );
    expect(settingsDestination).toHaveFocus();
    expect(onRequestComposerFocus).not.toHaveBeenCalled();
    window.removeEventListener(OPEN_SETTINGS_EVENT, openSettings);
  });

  it("routes not-ready external agents to Providers settings instead of selecting", async () => {
    const user = userEvent.setup();
    const onAgentChange = vi.fn();
    const openSettings = vi.fn();
    window.addEventListener(OPEN_SETTINGS_EVENT, openSettings);

    render(
      <AgentModelPicker
        agents={[
          { id: "goose", label: "Goose", readiness: "ready" },
          {
            id: "codex-acp",
            label: "Codex",
            readiness: "not_ready",
            setupAction: "connect",
          },
        ]}
        selectedAgentId="goose"
        onAgentChange={onAgentChange}
        availableModels={[]}
        onModelChange={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /choose agent and model/i }),
    );
    await user.click(screen.getByRole("button", { name: /codex/i }));

    expect(onAgentChange).not.toHaveBeenCalled();
    expect(openSettings).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { section: "providers" } }),
    );
    window.removeEventListener(OPEN_SETTINGS_EVENT, openSettings);
  });

  it("uses a fallback icon for unknown compact icon-only providers", () => {
    render(
      <AgentModelPicker
        agents={[{ id: "custom-provider", label: "Custom Provider" }]}
        selectedAgentId="custom-provider"
        onAgentChange={vi.fn()}
        availableModels={[]}
        onModelChange={vi.fn()}
        triggerIconOnly
      />,
    );

    const trigger = screen.getByRole("button", {
      name: /choose agent and model/i,
    });
    expect(trigger).toHaveTextContent("");
    expect(trigger).not.toHaveAttribute("title");
    expect(trigger.querySelector("svg")).not.toBeNull();
  });

  it("uses the selected agent label while a raw model id is unresolved", () => {
    render(
      <AgentModelPicker
        agents={AGENTS}
        selectedAgentId="claude-acp"
        onAgentChange={vi.fn()}
        currentModelId="opus"
        currentModelProviderId="claude-acp"
        currentModelName="opus"
        availableModels={[]}
        onModelChange={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: /choose agent and model/i,
    });
    expect(trigger).toHaveTextContent("Claude Code");
    expect(trigger).not.toHaveTextContent("opus");
  });

  it("uses the available model label for a matching raw model id", () => {
    render(
      <AgentModelPicker
        agents={AGENTS}
        selectedAgentId="claude-acp"
        onAgentChange={vi.fn()}
        currentModelId="opus"
        currentModelProviderId="claude-acp"
        currentModelName="opus"
        availableModels={[{ id: "opus", name: "Claude Opus 4.6" }]}
        onModelChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: /choose agent and model/i }),
    ).toHaveTextContent("Claude Opus 4.6");
  });

  it("shows an explicit Goose model before the loaded default model", async () => {
    const user = userEvent.setup();

    render(
      <AgentModelPicker
        agents={AGENTS}
        selectedAgentId="goose"
        onAgentChange={vi.fn()}
        currentModelId="goose-claude-opus-4-8"
        currentModelProviderId="databricks_v2"
        currentModelName="goose-claude-opus-4-8"
        availableModels={[
          {
            id: "goose-claude-opus-4-8",
            name: "Claude Opus 4.8",
            providerId: "databricks_v2",
          },
          {
            id: "gpt-5.5",
            name: "GPT 5.5",
            providerId: "openai",
            recommended: true,
          },
        ]}
        onModelChange={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: /choose agent and model/i,
    });
    expect(trigger).toHaveTextContent("Claude Opus 4.8");
    expect(trigger).not.toHaveTextContent("GPT 5.5");

    await user.click(trigger);

    const explicitModel = screen.getByRole("button", {
      name: /Claude Opus 4\.8/,
    });
    expect(explicitModel).toHaveClass("bg-accent");
    expect(
      explicitModel.querySelector(".tabler-icon-check"),
    ).toBeInTheDocument();
  });

  it("does not synthesize an external harness model into Goose", async () => {
    const user = userEvent.setup();
    render(
      <AgentModelPicker
        agents={AGENTS}
        selectedAgentId="goose"
        onAgentChange={vi.fn()}
        currentModelId="synthetic-model"
        currentModelProviderId="codex-acp"
        currentModelName="synthetic-model"
        availableModels={[
          {
            id: "goose-gpt-5-5",
            name: "GPT-5.5",
            providerId: "databricks_v2",
            recommended: true,
          },
        ]}
        onModelChange={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /choose agent and model/i }),
    );
    expect(
      screen.queryByRole("button", { name: /synthetic-model/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /GPT-5\.5/i }),
    ).toBeInTheDocument();
  });

  it("keeps an unresolved raw model id in the trigger instead of the recommended model", () => {
    render(
      <AgentModelPicker
        agents={AGENTS}
        selectedAgentId="goose"
        onAgentChange={vi.fn()}
        currentModelId="claude-fable"
        currentModelProviderId="databricks_v2"
        currentModelName="claude-fable"
        availableModels={[
          {
            id: "goose-gpt-5-5",
            name: "GPT-5.5",
            providerId: "databricks_v2",
            recommended: true,
          },
        ]}
        onModelChange={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: /choose agent and model/i,
    });
    expect(trigger).toHaveTextContent("claude-fable");
    expect(trigger).not.toHaveTextContent("GPT-5.5");
  });

  it("uses a stored human model name before models resolve", () => {
    render(
      <AgentModelPicker
        agents={AGENTS}
        selectedAgentId="claude-acp"
        onAgentChange={vi.fn()}
        currentModelId="opus"
        currentModelProviderId="claude-acp"
        currentModelName="Claude Opus 4.6"
        availableModels={[]}
        onModelChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: /choose agent and model/i }),
    ).toHaveTextContent("Claude Opus 4.6");
  });

  it("allows id-as-display-name labels after models resolve", () => {
    render(
      <AgentModelPicker
        agents={AGENTS}
        selectedAgentId="goose"
        onAgentChange={vi.fn()}
        currentModelId="gpt-5.4"
        currentModelName="gpt-5.4"
        availableModels={[{ id: "gpt-5.4", name: "gpt-5.4" }]}
        onModelChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: /choose agent and model/i }),
    ).toHaveTextContent("gpt-5.4");
  });

  it("does not show a raw model id in the loading row", async () => {
    const user = userEvent.setup();

    render(
      <AgentModelPicker
        agents={AGENTS}
        selectedAgentId="claude-acp"
        onAgentChange={vi.fn()}
        currentModelId="opus"
        currentModelProviderId="claude-acp"
        currentModelName="opus"
        availableModels={[]}
        modelsLoading
        onModelChange={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /choose agent and model/i }),
    );

    expect(screen.getByText("Loading models...")).toBeInTheDocument();
    expect(screen.queryByText("opus")).not.toBeInTheDocument();
  });

  it("calls onModelChange when a model is selected", async () => {
    const user = userEvent.setup();
    const onModelChange = vi.fn();

    render(
      <AgentModelPicker
        agents={AGENTS}
        selectedAgentId="goose"
        onAgentChange={vi.fn()}
        currentModelId="claude-sonnet-4"
        currentModelName="Claude Sonnet 4"
        availableModels={[
          { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
          { id: "gpt-4o", name: "GPT-4o" },
        ]}
        onModelChange={onModelChange}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /choose agent and model/i }),
    );

    await user.click(screen.getByRole("button", { name: "GPT-4o" }));

    expect(onModelChange).toHaveBeenCalledWith(
      "gpt-4o",
      expect.objectContaining({ id: "gpt-4o" }),
    );
    expect(screen.getByText("Agent")).toBeInTheDocument();
  });

  it("shows reasoning effort as a picker column when available", async () => {
    const user = userEvent.setup();
    const onReasoningEffortChange = vi.fn();

    render(
      <AgentModelPicker
        agents={AGENTS}
        selectedAgentId="goose"
        onAgentChange={vi.fn()}
        currentModelId="gpt-5.5"
        currentModelName="GPT 5.5"
        availableModels={[{ id: "gpt-5.5", name: "GPT 5.5" }]}
        onModelChange={vi.fn()}
        reasoningEffort={{
          config: {
            configId: "thinking_effort",
            currentValue: "medium",
            options: [
              { id: "low", name: "low" },
              { id: "medium", name: "medium" },
              { id: "high", name: "high" },
            ],
          },
          onChange: onReasoningEffortChange,
        }}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: /choose agent and model/i,
    });
    expect(trigger).toHaveTextContent("GPT 5.5");
    expect(trigger).toHaveTextContent("Medium");
    expect(trigger).toHaveClass("group");
    expect(screen.getByText("Medium")).toHaveClass(
      "text-muted-foreground/70",
      "dark:group-hover:text-foreground",
      "dark:group-data-[state=open]:text-foreground",
      "dark:group-aria-expanded:text-foreground",
    );

    await user.click(trigger);

    expect(screen.getByText("Reasoning effort")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "High" }));

    expect(onReasoningEffortChange).toHaveBeenCalledWith("high");
  });

  it("hides off reasoning effort in the picker trigger", () => {
    render(
      <AgentModelPicker
        agents={AGENTS}
        selectedAgentId="goose"
        onAgentChange={vi.fn()}
        currentModelId="gpt-5.5"
        currentModelName="GPT 5.5"
        availableModels={[{ id: "gpt-5.5", name: "GPT 5.5" }]}
        onModelChange={vi.fn()}
        reasoningEffort={{
          config: {
            configId: "thinking_effort",
            currentValue: "off",
            options: [
              { id: "off", name: "off" },
              { id: "low", name: "low" },
              { id: "medium", name: "medium" },
            ],
          },
          onChange: vi.fn(),
        }}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: /choose agent and model/i,
    });
    expect(trigger).toHaveTextContent("GPT 5.5");
    expect(trigger).not.toHaveTextContent("Off");
  });

  it("keeps the reasoning column stable while model reasoning config refreshes", async () => {
    const user = userEvent.setup();
    const reasoningEffortConfig = {
      configId: "thinking_effort",
      currentValue: "medium",
      options: [
        { id: "low", name: "low" },
        { id: "medium", name: "medium" },
        { id: "high", name: "high" },
      ],
    };

    const { rerender } = render(
      <AgentModelPicker
        agents={AGENTS}
        selectedAgentId="goose"
        onAgentChange={vi.fn()}
        currentModelId="gpt-5.5"
        currentModelName="GPT 5.5"
        availableModels={[{ id: "gpt-5.5", name: "GPT 5.5" }]}
        onModelChange={vi.fn()}
        reasoningEffort={{
          config: reasoningEffortConfig,
          onChange: vi.fn(),
        }}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /choose agent and model/i }),
    );

    expect(screen.getByText("Reasoning effort")).toBeInTheDocument();

    rerender(
      <AgentModelPicker
        agents={AGENTS}
        selectedAgentId="goose"
        onAgentChange={vi.fn()}
        currentModelId="claude-opus-4-8"
        currentModelName="Claude Opus 4.8"
        availableModels={[{ id: "claude-opus-4-8", name: "Claude Opus 4.8" }]}
        onModelChange={vi.fn()}
        reasoningEffort={{
          config: undefined,
          onChange: vi.fn(),
        }}
      />,
    );

    expect(screen.getByText("Reasoning effort")).toBeInTheDocument();
    expect(
      screen.getByText("Reasoning effort").closest("[aria-busy='true']"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "High" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    rerender(
      <AgentModelPicker
        agents={AGENTS}
        selectedAgentId="goose"
        onAgentChange={vi.fn()}
        currentModelId="gpt-4o"
        currentModelName="GPT-4o"
        availableModels={[{ id: "gpt-4o", name: "GPT-4o" }]}
        onModelChange={vi.fn()}
        reasoningEffort={{
          config: {
            configId: "thinking_effort",
            currentValue: "off",
            options: [{ id: "off", name: "off" }],
          },
          onChange: vi.fn(),
        }}
      />,
    );

    await waitFor(
      () => {
        expect(screen.queryByText("Reasoning effort")).not.toBeInTheDocument();
      },
      { timeout: 500 },
    );
  });

  it("passes the clicked model option through for duplicate model ids", async () => {
    const user = userEvent.setup();
    const onModelChange = vi.fn();

    render(
      <AgentModelPicker
        agents={AGENTS}
        selectedAgentId="goose"
        onAgentChange={vi.fn()}
        currentModelId="llama3.2"
        currentModelProviderId="custom_ollama"
        currentModelName="llama3.2"
        availableModels={[
          {
            id: "llama3.2",
            name: "llama3.2",
            providerId: "ollama",
            providerName: "Ollama",
            recommended: true,
          },
          {
            id: "llama3.2",
            name: "llama3.2",
            providerId: "custom_ollama",
            providerName: "Custom Ollama",
            recommended: true,
          },
        ]}
        onModelChange={onModelChange}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /choose agent and model/i }),
    );

    const duplicateModelRows = screen.getAllByRole("button", {
      name: "llama3.2",
    });

    const selectedDuplicateRows = duplicateModelRows.filter((row) =>
      row.classList.contains("bg-accent"),
    );
    expect(selectedDuplicateRows).toHaveLength(1);

    await user.click(selectedDuplicateRows[0]);

    expect(onModelChange).toHaveBeenCalledWith(
      "llama3.2",
      expect.objectContaining({
        name: "llama3.2",
        providerId: "custom_ollama",
      }),
    );
  });

  it("does not select providerless duplicate rows when the current provider is known", async () => {
    const user = userEvent.setup();

    render(
      <AgentModelPicker
        agents={AGENTS}
        selectedAgentId="goose"
        onAgentChange={vi.fn()}
        currentModelId="llama3.2"
        currentModelProviderId="custom_ollama"
        currentModelName="llama3.2"
        availableModels={[
          {
            id: "llama3.2",
            name: "llama3.2",
            recommended: true,
          },
          {
            id: "llama3.2",
            name: "llama3.2",
            providerId: "custom_ollama",
            providerName: "Custom Ollama",
            recommended: true,
          },
        ]}
        onModelChange={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /choose agent and model/i }),
    );

    const duplicateModelRows = screen.getAllByRole("button", {
      name: "llama3.2",
    });

    expect(
      duplicateModelRows.filter((row) => row.classList.contains("bg-accent")),
    ).toHaveLength(1);
  });

  it("auto-expands the group containing the selected model", async () => {
    const user = userEvent.setup();

    render(
      <AgentModelPicker
        agents={AGENTS}
        selectedAgentId="goose"
        onAgentChange={vi.fn()}
        currentModelId="claude-sonnet-4"
        currentModelName="Claude Sonnet 4"
        availableModels={[
          { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
          { id: "gpt-4o", name: "GPT-4o" },
        ]}
        onModelChange={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /choose agent and model/i }),
    );

    expect(
      screen.getByRole("button", { name: "Claude Sonnet 4" }),
    ).toBeInTheDocument();
  });

  it("keeps long model names in constrained rows", async () => {
    const user = userEvent.setup();

    render(
      <AgentModelPicker
        agents={AGENTS}
        selectedAgentId="goose"
        onAgentChange={vi.fn()}
        currentModelId="databricks-gpt-5-4-mini"
        currentModelName="databricks-gpt-5-4-mini"
        availableModels={[
          {
            id: "databricks-gpt-5-4-mini",
            name: "databricks-gpt-5-4-mini",
            provider: "OpenAI",
          },
          {
            id: "databricks-gpt-5-4-nano-preview-super-long",
            name: "databricks-gpt-5-4-nano-preview-super-long",
            provider: "OpenAI",
          },
        ]}
        onModelChange={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /choose agent and model/i }),
    );

    const longModelButton = screen.getByRole("button", {
      name: "databricks-gpt-5-4-mini",
    });
    const longModelLabel = within(longModelButton).getByText(
      "databricks-gpt-5-4-mini",
    );

    expect(longModelButton).toHaveClass("min-w-0");
    expect(longModelButton).toHaveClass("overflow-hidden");
    expect(longModelLabel).toHaveClass("truncate");
    expect(longModelLabel.closest("[data-slot='scroll-area']")).toHaveClass(
      "[&_[data-slot=scroll-area-viewport]>div]:!block",
    );
  });

  it("shows search for a long list without a recommended shortlist", async () => {
    const user = userEvent.setup();
    const models = Array.from({ length: 12 }, (_, index) => ({
      id: `model-${index}`,
      name: `Model ${index}`,
    }));

    render(
      <AgentModelPicker
        agents={AGENTS}
        selectedAgentId="goose"
        onAgentChange={vi.fn()}
        currentModelId="model-0"
        currentModelName="Model 0"
        availableModels={models}
        onModelChange={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /choose agent and model/i }),
    );
    const picker = screen.getByRole("dialog");
    const searchButton = within(picker).getByRole("button", {
      name: "Search models...",
    });
    // Nothing is hidden behind a shortlist, so "View more" must not render.
    expect(
      within(picker).queryByRole("button", { name: "View more" }),
    ).not.toBeInTheDocument();

    await user.click(searchButton);
    const search = within(picker).getByRole("searchbox", {
      name: "Search models...",
    });
    await user.type(search, "Model 7");
    expect(
      within(picker).getByRole("button", { name: "Model 7" }),
    ).toBeInTheDocument();
    expect(
      within(picker).queryByRole("button", { name: "Model 3" }),
    ).not.toBeInTheDocument();
  });

  it("gates threshold search exactly at the boundary", async () => {
    const user = userEvent.setup();
    const buildModels = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `model-${index}`,
        name: `Model ${index}`,
      }));
    const renderPicker = (count: number) =>
      render(
        <AgentModelPicker
          agents={AGENTS}
          selectedAgentId="goose"
          onAgentChange={vi.fn()}
          currentModelId="model-0"
          currentModelName="Model 0"
          availableModels={buildModels(count)}
          onModelChange={vi.fn()}
        />,
      );

    // At the threshold (8 uncurated models): no search button.
    const atThreshold = renderPicker(8);
    await user.click(
      screen.getByRole("button", { name: /choose agent and model/i }),
    );
    expect(
      within(screen.getByRole("dialog")).queryByRole("button", {
        name: "Search models...",
      }),
    ).not.toBeInTheDocument();
    atThreshold.unmount();

    // One past the threshold (9 uncurated models): search appears.
    renderPicker(9);
    await user.click(
      screen.getByRole("button", { name: /choose agent and model/i }),
    );
    expect(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Search models...",
      }),
    ).toBeInTheDocument();
  });

  it("hides search for a short list with nothing hidden", async () => {
    const user = userEvent.setup();

    render(
      <AgentModelPicker
        agents={AGENTS}
        selectedAgentId="goose"
        onAgentChange={vi.fn()}
        currentModelId="model-0"
        currentModelName="Model 0"
        availableModels={[
          { id: "model-0", name: "Model 0" },
          { id: "model-1", name: "Model 1" },
        ]}
        onModelChange={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /choose agent and model/i }),
    );
    const picker = screen.getByRole("dialog");
    expect(
      within(picker).queryByRole("button", { name: "Search models..." }),
    ).not.toBeInTheDocument();
    expect(
      within(picker).queryByRole("button", { name: "View more" }),
    ).not.toBeInTheDocument();
  });

  it("disables spellcheck in the all-models search field", async () => {
    const user = userEvent.setup();

    render(
      <AgentModelPicker
        agents={AGENTS}
        selectedAgentId="goose"
        onAgentChange={vi.fn()}
        currentModelId="claude-sonnet-4"
        currentModelName="Claude Sonnet 4"
        availableModels={[
          { id: "claude-sonnet-4", name: "Claude Sonnet 4", recommended: true },
          { id: "gpt-4o-mini-2024-07-18", name: "GPT-4o mini" },
        ]}
        onModelChange={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /choose agent and model/i }),
    );
    const searchButton = screen.getByRole("button", {
      name: "Search models...",
    });
    const picker = screen.getByRole("dialog");
    expect(searchButton.parentElement).toHaveTextContent("Model");
    expect(searchButton).toHaveClass("mr-3", "h-6", "w-6");
    expect(picker).toHaveClass("w-[26.25rem]");
    expect(within(picker).getByText("Claude Sonnet 4")).toBeInTheDocument();
    expect(within(picker).queryByText("GPT-4o mini")).not.toBeInTheDocument();
    expect(
      within(picker).queryByText("gpt-4o-mini-2024-07-18"),
    ).not.toBeInTheDocument();
    const viewMoreButton = within(picker).getByRole("button", {
      name: "View more",
    });
    expect(viewMoreButton).toHaveClass("text-sm", "text-muted-foreground/70");
    expect(viewMoreButton.querySelector("svg")).toHaveClass("size-3.5");
    expect(viewMoreButton.parentElement).toHaveClass("pr-3");
    const modelViewport = viewMoreButton
      .closest("[data-slot='scroll-area']")
      ?.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']");
    expect(modelViewport).toBeInTheDocument();
    if (modelViewport) {
      modelViewport.scrollTop = 120;
    }
    await user.click(viewMoreButton);

    expect(modelViewport?.scrollTop).toBe(0);
    expect(
      screen.queryByPlaceholderText("Search models..."),
    ).not.toBeInTheDocument();
    expect(within(picker).getByText("GPT-4o mini")).toBeInTheDocument();
    expect(
      within(picker).queryByRole("button", { name: "View more" }),
    ).not.toBeInTheDocument();
    expect(
      within(picker).queryByText("gpt-4o-mini-2024-07-18"),
    ).not.toBeInTheDocument();

    await user.click(searchButton);
    const search = screen.getByPlaceholderText("Search models...");

    expect(search).toHaveAttribute("spellcheck", "false");
    expect(modelViewport?.scrollTop).toBe(0);
    const searchField = search.closest(".bg-accent");
    expect(searchField).toBeInTheDocument();
    expect(searchField?.parentElement?.parentElement).toHaveClass("px-1");
    expect(searchField?.parentElement).toHaveClass("mr-2");
    expect(searchField).toHaveClass(
      "bg-accent",
      "hover:bg-accent",
      "focus-within:bg-accent",
      "px-0",
    );
    expect(searchField?.querySelector("svg")).toHaveClass("left-2");
    expect(search).toHaveClass(
      "min-w-0",
      "appearance-none",
      "pl-8",
      "pr-8",
      "text-sm",
      "[&::-webkit-search-cancel-button]:hidden",
    );
    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(within(picker).getByText("GPT-4o mini")).toBeInTheDocument();
    expect(
      within(picker).queryByText("gpt-4o-mini-2024-07-18"),
    ).not.toBeInTheDocument();
    expect(picker).toHaveClass("w-[26.25rem]");

    if (modelViewport) {
      modelViewport.scrollTop = 120;
    }
    await user.type(search, "GPT");
    expect(modelViewport?.scrollTop).toBe(0);
    const closeButton = screen.getByRole("button", { name: "Close search" });
    expect(closeButton).toHaveClass("right-1", "h-6", "w-6");
    if (modelViewport) {
      modelViewport.scrollTop = 120;
    }
    await user.click(closeButton);

    expect(
      screen.queryByPlaceholderText("Search models..."),
    ).not.toBeInTheDocument();
    expect(modelViewport?.scrollTop).toBe(0);
    expect(
      within(picker).getByRole("button", { name: "Search models..." }),
    ).toHaveFocus();
    expect(screen.getByText("Model")).toBeInTheDocument();
    expect(
      within(picker).queryByRole("button", { name: "View more" }),
    ).not.toBeInTheDocument();

    await user.click(
      within(picker).getByRole("button", { name: /GPT-4o mini/ }),
    );

    // The selection is recorded as recently used, so it joins the compact
    // shortlist and nothing is left behind "View more".
    expect(
      within(picker).queryByRole("button", { name: "View more" }),
    ).not.toBeInTheDocument();
    expect(within(picker).getByText("GPT-4o mini")).toBeInTheDocument();
  });

  it("keeps keyboard navigation on picker rows and preserves search caret keys", async () => {
    const user = userEvent.setup();

    render(
      <AgentModelPicker
        agents={AGENTS}
        selectedAgentId="goose"
        onAgentChange={vi.fn()}
        currentModelId="claude-sonnet-4"
        currentModelName="Claude Sonnet 4"
        availableModels={[
          { id: "claude-sonnet-4", name: "Claude Sonnet 4", recommended: true },
          { id: "gpt-4o-mini", name: "GPT-4o mini" },
        ]}
        onModelChange={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /choose agent and model/i }),
    );

    const picker = screen.getByRole("dialog");
    const selectedAgent = within(picker).getByRole("button", {
      name: "Goose Goose",
    });
    const selectedModel = within(picker).getByRole("button", {
      name: "Claude Sonnet 4",
    });
    const searchButton = within(picker).getByRole("button", {
      name: "Search models...",
    });

    await waitFor(() => expect(selectedAgent).toHaveFocus());
    await user.keyboard("{ArrowRight}");
    expect(selectedModel).toHaveFocus();
    expect(searchButton).not.toHaveFocus();

    await user.click(searchButton);
    const search = within(picker).getByRole("searchbox", {
      name: "Search models...",
    });
    const lastModel = within(picker).getByRole("button", {
      name: "GPT-4o mini",
    });
    expect(search).toHaveFocus();

    await user.keyboard("{ArrowLeft}");
    expect(search).toHaveFocus();

    await user.keyboard("{ArrowUp}");
    expect(lastModel).toHaveFocus();

    search.focus();
    await user.keyboard("{ArrowDown}");
    expect(selectedModel).toHaveFocus();
    expect(
      within(picker).getByRole("button", { name: "Close search" }),
    ).not.toHaveFocus();

    search.focus();
    await user.keyboard("{Escape}");
    expect(
      within(picker).queryByRole("searchbox", { name: "Search models..." }),
    ).not.toBeInTheDocument();
    expect(
      within(picker).getByRole("button", { name: "Search models..." }),
    ).toHaveFocus();
  });

  it("closes model search with Escape from another picker column", async () => {
    const user = userEvent.setup();

    render(
      <AgentModelPicker
        agents={AGENTS}
        selectedAgentId="goose"
        onAgentChange={vi.fn()}
        currentModelId="claude-sonnet-4"
        currentModelName="Claude Sonnet 4"
        availableModels={[
          { id: "claude-sonnet-4", name: "Claude Sonnet 4", recommended: true },
          { id: "gpt-4o-mini", name: "GPT-4o mini" },
        ]}
        onModelChange={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /choose agent and model/i }),
    );

    const picker = screen.getByRole("dialog");
    await user.click(
      within(picker).getByRole("button", { name: "Search models..." }),
    );
    const selectedAgent = within(picker).getByRole("button", {
      name: "Goose Goose",
    });
    selectedAgent.focus();

    await user.keyboard("{Escape}");

    expect(
      within(picker).queryByRole("searchbox", { name: "Search models..." }),
    ).not.toBeInTheDocument();
    expect(picker).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows only agent name when no model info is available", () => {
    render(
      <AgentModelPicker
        agents={AGENTS}
        selectedAgentId="goose"
        onAgentChange={vi.fn()}
        currentModelId={null}
        currentModelName={null}
        availableModels={[]}
        onModelChange={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: /choose agent and model/i,
    });
    expect(trigger).toHaveTextContent("Goose");
    expect(trigger).not.toHaveTextContent("·");
  });

  it("uses a recommended model label before falling back to the agent label", () => {
    render(
      <AgentModelPicker
        agents={AGENTS}
        selectedAgentId="goose"
        onAgentChange={vi.fn()}
        currentModelId={null}
        currentModelName={null}
        availableModels={[
          { id: "gpt-5", name: "GPT 5" },
          {
            id: "claude-sonnet-4",
            name: "Claude Sonnet 4",
            recommended: true,
          },
        ]}
        onModelChange={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: /choose agent and model/i,
    });
    expect(trigger).toHaveTextContent("Claude Sonnet 4");
  });

  it("shows a loading state while models are refreshing", async () => {
    const user = userEvent.setup();

    render(
      <AgentModelPicker
        agents={AGENTS}
        selectedAgentId="goose"
        onAgentChange={vi.fn()}
        currentModelId={null}
        currentModelName={null}
        availableModels={[]}
        modelsLoading
        onModelChange={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /choose agent and model/i }),
    );

    expect(screen.getByText("Loading models...")).toBeInTheDocument();
  });

  it("shows an empty-state message when no models are available", async () => {
    const user = userEvent.setup();

    render(
      <AgentModelPicker
        agents={AGENTS}
        selectedAgentId="goose"
        onAgentChange={vi.fn()}
        currentModelId={null}
        currentModelName={null}
        availableModels={[]}
        onModelChange={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /choose agent and model/i }),
    );

    expect(screen.getByText("No models available")).toBeInTheDocument();
  });

  describe("gated provider column", () => {
    const renderGated = ({
      agents = AGENTS,
      onAgentChange = vi.fn(),
      currentModelId = "gpt-4o",
      currentModelName = "GPT-4o",
      availableModels = [{ id: "gpt-4o", name: "GPT-4o" }],
    }: Partial<
      Pick<
        ComponentProps<typeof AgentModelPicker>,
        | "agents"
        | "onAgentChange"
        | "currentModelId"
        | "currentModelName"
        | "availableModels"
      >
    > = {}) =>
      render(
        <AgentModelPicker
          agents={agents}
          selectedAgentId="goose"
          onAgentChange={onAgentChange}
          currentModelId={currentModelId}
          currentModelName={currentModelName}
          availableModels={availableModels}
          onModelChange={vi.fn()}
          providerColumnMode="gated"
        />,
      );

    // Enough non-recommended models for the search and "View more" affordances.
    const BROWSABLE_MODELS = [
      { id: "gpt-4o", name: "GPT-4o", recommended: true },
      { id: "o3-mini", name: "o3 mini" },
      { id: "o4-mini", name: "o4 mini" },
    ];

    const openPicker = (user: ReturnType<typeof userEvent.setup>) =>
      user.click(
        screen.getByRole("button", { name: /choose agent and model/i }),
      );

    it("collapses the agent column behind a switch-agent button", async () => {
      const user = userEvent.setup();
      renderGated();

      await openPicker(user);

      const agentColumn = document.querySelector('[data-col="agent"]');
      expect(agentColumn).toHaveAttribute("data-hidden", "true");
      for (const item of agentColumn?.querySelectorAll("button") ?? []) {
        expect(item).toHaveAttribute("tabindex", "-1");
      }
      expect(screen.queryByRole("button", { name: "Claude Code" })).toBeNull();
      expect(
        screen.getByRole("button", { name: /switch agent/i }),
      ).toBeInTheDocument();
    });

    it("focuses the selected model row on open", async () => {
      const user = userEvent.setup();
      renderGated();

      await openPicker(user);

      expect(
        document.querySelector('[data-col="model"] button[data-selected]'),
      ).toHaveFocus();
    });

    it("focuses the first model row when nothing is selected", async () => {
      const user = userEvent.setup();
      renderGated({
        currentModelId: null,
        currentModelName: null,
        availableModels: [
          { id: "gpt-4o", name: "GPT-4o" },
          { id: "claude-sonnet", name: "Claude Sonnet" },
        ],
      });

      await openPicker(user);

      expect(
        document.querySelector('[data-col="model"] button[data-selected]'),
      ).toBeNull();
      expect(
        document.querySelector(
          '[data-col="model"] button[data-picker-nav-item]',
        ),
      ).toHaveFocus();
    });

    it("focuses the switch-agent button when there are no models", async () => {
      const user = userEvent.setup();
      renderGated({
        currentModelId: null,
        currentModelName: null,
        availableModels: [],
      });

      await openPicker(user);

      expect(
        screen.getByRole("button", { name: /switch agent/i }),
      ).toHaveFocus();
    });

    it("hides the switch-agent button while searching models", async () => {
      const user = userEvent.setup();
      renderGated({ availableModels: BROWSABLE_MODELS });

      await openPicker(user);
      await user.click(screen.getByRole("button", { name: /search models/i }));

      expect(
        screen.queryByRole("button", { name: /switch agent/i }),
      ).toBeNull();

      await user.keyboard("{Escape}");

      expect(
        screen.getByRole("button", { name: /switch agent/i }),
      ).toBeInTheDocument();
    });

    it("hides the switch-agent button while browsing all models", async () => {
      const user = userEvent.setup();
      renderGated({ availableModels: BROWSABLE_MODELS });

      await openPicker(user);
      await user.click(screen.getByRole("button", { name: /view more/i }));

      expect(
        screen.queryByRole("button", { name: /switch agent/i }),
      ).toBeNull();

      await user.keyboard("{Escape}");
      await waitFor(() => {
        expect(document.querySelector('[data-col="model"]')).toBeNull();
      });
      await openPicker(user);

      expect(
        screen.getByRole("button", { name: /switch agent/i }),
      ).toBeInTheDocument();
    });

    it("reveals the agent column and still switches providers", async () => {
      const user = userEvent.setup();
      const onAgentChange = vi.fn();
      renderGated({ onAgentChange });

      await openPicker(user);
      await user.click(screen.getByRole("button", { name: /switch agent/i }));

      expect(document.querySelector('[data-col="agent"]')).toHaveAttribute(
        "data-hidden",
        "false",
      );
      expect(
        screen.queryByRole("button", { name: /switch agent/i }),
      ).toBeNull();
      expect(
        document.querySelector('[data-col="agent"] button[data-selected]'),
      ).toHaveFocus();

      await user.click(screen.getByRole("button", { name: "Claude Code" }));

      expect(onAgentChange).toHaveBeenCalledWith("claude-acp");
    });

    it("re-gates the agent column on the next open", async () => {
      const user = userEvent.setup();
      renderGated();

      await openPicker(user);
      await user.click(screen.getByRole("button", { name: /switch agent/i }));
      expect(document.querySelector('[data-col="agent"]')).toHaveAttribute(
        "data-hidden",
        "false",
      );

      await user.keyboard("{Escape}");
      await waitFor(() => {
        expect(document.querySelector('[data-col="agent"]')).toBeNull();
      });

      await openPicker(user);

      expect(document.querySelector('[data-col="agent"]')).toHaveAttribute(
        "data-hidden",
        "true",
      );
      expect(
        screen.getByRole("button", { name: /switch agent/i }),
      ).toBeInTheDocument();
    });

    it("stays compact while collapsed and widens on reveal", async () => {
      const user = userEvent.setup();

      render(
        <AgentModelPicker
          agents={AGENTS}
          selectedAgentId="goose"
          onAgentChange={vi.fn()}
          currentModelId="gpt-5.5"
          currentModelName="GPT 5.5"
          availableModels={[{ id: "gpt-5.5", name: "GPT 5.5" }]}
          onModelChange={vi.fn()}
          providerColumnMode="gated"
          reasoningEffort={{
            config: {
              configId: "thinking_effort",
              currentValue: "medium",
              options: [
                { id: "low", name: "low" },
                { id: "medium", name: "medium" },
                { id: "high", name: "high" },
              ],
            },
            onChange: vi.fn(),
          }}
        />,
      );

      await openPicker(user);

      const content = document.querySelector('[data-slot="popover-content"]');
      expect(content).toHaveClass("w-[26.25rem]");

      await user.click(screen.getByRole("button", { name: /switch agent/i }));

      expect(content).toHaveClass("w-[37.25rem]");
    });

    it("hides the switch-agent button when the only agent is ready", async () => {
      const user = userEvent.setup();
      renderGated({ agents: [{ id: "goose", label: "Goose" }] });

      await openPicker(user);

      expect(
        screen.queryByRole("button", { name: /switch agent/i }),
      ).toBeNull();
    });

    it("keeps the switch-agent button when the only agent needs setup", async () => {
      const user = userEvent.setup();
      const openSettings = vi.fn();
      window.addEventListener(OPEN_SETTINGS_EVENT, openSettings);
      renderGated({
        agents: [
          {
            id: "goose",
            label: "Goose",
            readiness: "not_ready",
            setupAction: "connect",
          },
        ],
      });

      await openPicker(user);
      await user.click(screen.getByRole("button", { name: /switch agent/i }));

      expect(document.querySelector('[data-col="agent"]')).toHaveAttribute(
        "data-hidden",
        "false",
      );
      const goose = screen.getByRole("button", { name: /goose/i });
      expect(goose).toHaveTextContent("Connect");

      await user.click(goose);

      expect(openSettings).toHaveBeenCalledWith(
        expect.objectContaining({ detail: { section: "providers" } }),
      );
      window.removeEventListener(OPEN_SETTINGS_EVENT, openSettings);
    });

    it("keeps the agent column visible by default", async () => {
      const user = userEvent.setup();

      render(
        <AgentModelPicker
          agents={AGENTS}
          selectedAgentId="goose"
          onAgentChange={vi.fn()}
          currentModelId="gpt-4o"
          currentModelName="GPT-4o"
          availableModels={[{ id: "gpt-4o", name: "GPT-4o" }]}
          onModelChange={vi.fn()}
        />,
      );

      await openPicker(user);

      expect(document.querySelector('[data-col="agent"]')).toHaveAttribute(
        "data-hidden",
        "false",
      );
      expect(
        screen.queryByRole("button", { name: /switch agent/i }),
      ).toBeNull();
      expect(
        screen.getByRole("button", { name: "Claude Code" }),
      ).toBeInTheDocument();
    });
  });

  describe("model recency", () => {
    type PickerProps = ComponentProps<typeof AgentModelPicker>;

    const renderPicker = (
      models: PickerProps["availableModels"],
      overrides: Partial<PickerProps> = {},
    ) =>
      render(
        <AgentModelPicker
          agents={AGENTS}
          selectedAgentId="goose"
          onAgentChange={vi.fn()}
          currentModelId={models[0]?.id}
          currentModelName={models[0]?.name}
          availableModels={models}
          onModelChange={vi.fn()}
          {...overrides}
        />,
      );

    const openPicker = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(
        screen.getByRole("button", { name: /choose agent and model/i }),
      );
      return screen.getByRole("dialog");
    };

    const modelRowNames = (picker: HTMLElement) =>
      Array.from(
        picker.querySelectorAll<HTMLButtonElement>(
          '[data-col="model"] button[data-picker-nav-item]',
        ),
      )
        .map((button) => button.textContent)
        .filter(
          (text): text is string => text !== null && text !== "View more",
        );

    it("records a selection under the selected agent", async () => {
      const user = userEvent.setup();
      renderPicker([
        { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
        { id: "gpt-4o", name: "GPT-4o" },
      ]);

      const picker = await openPicker(user);
      await user.click(within(picker).getByRole("button", { name: "GPT-4o" }));

      const map = getModelRecencyMap();
      expect(Object.keys(map)).toHaveLength(1);
      expect(getModelRecencyRank(map, "goose", { id: "gpt-4o" })).toEqual(
        expect.any(Number),
      );
    });

    it("selects a model when recency persistence exceeds quota", async () => {
      const user = userEvent.setup();
      const onModelChange = vi.fn();
      const setItem = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(() => {
          throw new DOMException("quota", "QuotaExceededError");
        });

      try {
        renderPicker(
          [
            { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
            { id: "gpt-4o", name: "GPT-4o" },
          ],
          { onModelChange },
        );

        const picker = await openPicker(user);
        await user.click(
          within(picker).getByRole("button", { name: "GPT-4o" }),
        );

        expect(onModelChange).toHaveBeenCalledWith(
          "gpt-4o",
          expect.objectContaining({ id: "gpt-4o" }),
        );
      } finally {
        setItem.mockRestore();
      }
    });

    it("orders recently used models ahead of alphabetical fallbacks", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(1_000);
      recordModelSelection("goose", { id: "zeta-model" });
      vi.setSystemTime(2_000);
      recordModelSelection("goose", { id: "omega-model" });
      const user = userEvent.setup();

      renderPicker([
        { id: "alpha-model", name: "Alpha Model", recommended: true },
        { id: "beta-model", name: "Beta Model", recommended: true },
        { id: "gamma-model", name: "Gamma Model", recommended: true },
        { id: "omega-model", name: "Omega Model", recommended: true },
        { id: "zeta-model", name: "Zeta Model", recommended: true },
      ]);

      const picker = await openPicker(user);

      expect(modelRowNames(picker)).toEqual([
        "Alpha Model",
        "Omega Model",
        "Zeta Model",
        "Beta Model",
        "Gamma Model",
      ]);
      expect(
        within(picker).queryByRole("button", { name: "View more" }),
      ).not.toBeInTheDocument();
    });

    it("folds recently used models into the compact view", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(1_000);
      recordModelSelection("goose", { id: "oldest-recent-model" });
      vi.setSystemTime(2_000);
      recordModelSelection("goose", { id: "older-recent-model" });
      vi.setSystemTime(3_000);
      recordModelSelection("goose", { id: "newer-recent-model" });
      vi.setSystemTime(4_000);
      recordModelSelection("goose", { id: "newest-recent-model" });
      const user = userEvent.setup();

      renderPicker([
        {
          id: "current-model",
          name: "Current Model",
          recommended: true,
        },
        {
          id: "harness-model",
          name: "Harness Model",
          recommended: true,
        },
        { id: "oldest-recent-model", name: "Oldest Recent Model" },
        { id: "older-recent-model", name: "Older Recent Model" },
        { id: "newer-recent-model", name: "Newer Recent Model" },
        { id: "newest-recent-model", name: "Newest Recent Model" },
      ]);

      const picker = await openPicker(user);

      expect(modelRowNames(picker)).toEqual([
        "Current Model",
        "Newest Recent Model",
        "Newer Recent Model",
        "Older Recent Model",
        "Harness Model",
      ]);
      expect(
        within(picker).queryByRole("button", { name: "Oldest Recent Model" }),
      ).not.toBeInTheDocument();
      const viewMore = within(picker).getByRole("button", {
        name: "View more",
      });
      expect(viewMore).toBeInTheDocument();

      await user.click(viewMore);

      expect(
        within(picker).getByRole("button", { name: "Oldest Recent Model" }),
      ).toBeInTheDocument();
    });

    it("deterministically limits models with tied recency ranks", async () => {
      const rank = 1_000;
      localStorage.setItem(
        MODEL_RECENCY_STORAGE_KEY,
        JSON.stringify({
          "goose/zulu/zulu-provider": rank,
          "goose/alpha/later-sort": rank,
          "goose/alpha/zulu-name": rank,
          "goose/alpha/alpha-name": rank,
        }),
      );
      const user = userEvent.setup();

      renderPicker(
        [
          {
            id: "zulu-provider",
            name: "Zulu Provider Model",
            providerId: "zulu",
            providerName: "Zulu Provider",
            sortOrder: 0,
          },
          {
            id: "later-sort",
            name: "Later Sort Model",
            providerId: "alpha",
            providerName: "Alpha Provider",
            sortOrder: 2,
          },
          {
            id: "zulu-name",
            name: "Zulu Name Model",
            providerId: "alpha",
            providerName: "Alpha Provider",
            sortOrder: 1,
          },
          {
            id: "alpha-name",
            name: "Alpha Name Model",
            providerId: "alpha",
            providerName: "Alpha Provider",
            sortOrder: 1,
          },
        ],
        { currentModelId: null, currentModelName: null },
      );

      const picker = await openPicker(user);

      expect(modelRowNames(picker)).toEqual([
        "Alpha Name Model",
        "Zulu Name Model",
        "Later Sort Model",
      ]);
      expect(
        within(picker).queryByRole("button", { name: "Zulu Provider Model" }),
      ).not.toBeInTheDocument();
      expect(
        within(picker).getByRole("button", { name: "View more" }),
      ).toBeInTheDocument();
    });

    it("does not leak recency across agents", async () => {
      const user = userEvent.setup();
      recordModelSelection("claude-acp", { id: "zeta-model" });

      renderPicker([
        { id: "alpha-model", name: "Alpha Model", recommended: true },
        { id: "beta-model", name: "Beta Model", recommended: true },
        { id: "zeta-model", name: "Zeta Model", recommended: true },
      ]);

      const picker = await openPicker(user);

      expect(modelRowNames(picker)).toEqual([
        "Alpha Model",
        "Beta Model",
        "Zeta Model",
      ]);
    });
  });
});
