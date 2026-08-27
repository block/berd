import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Persona } from "@/shared/types/agents";
import type { WidgetInstance, WidgetRenderProps } from "./types";
import { PromptPinWidget } from "./PromptPinWidget";

const state = vi.hoisted(() => ({ personas: [] as Persona[] }));

vi.mock("@/features/agents/stores/agentStore", () => ({
  useAgentStore: (selector: (store: { personas: Persona[] }) => unknown) =>
    selector(state),
}));

function persona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: "agent-1",
    displayName: "Agent One",
    systemPrompt: "You are a focused coding agent.",
    isBuiltin: false,
    writable: true,
    ...overrides,
  };
}

function makeInstance(widgetState?: Record<string, unknown>): WidgetInstance {
  return {
    id: "prompt-pin-1",
    type: "promptPin",
    x: 20,
    y: 30,
    z: 1,
    state: widgetState,
  };
}

// A finished pin is identified by its persisted mode, never by having saved
// text — the editor saves text on a debounce while it is still open.
function readyState(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { mode: "ready", ...extra };
}

function renderPin({
  widgetState,
  onUpdateState = vi.fn(),
  onRemoveWidget,
  onRunPrompt,
}: {
  widgetState?: Record<string, unknown>;
  onUpdateState?: WidgetRenderProps["onUpdateState"];
  onRemoveWidget?: WidgetRenderProps["onRemoveWidget"];
  onRunPrompt?: WidgetRenderProps["onRunPrompt"];
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  }

  return render(
    <PromptPinWidget
      instance={makeInstance(widgetState)}
      onUpdateState={onUpdateState}
      onRemoveWidget={onRemoveWidget}
      onRunPrompt={onRunPrompt}
    />,
    { wrapper: Wrapper },
  );
}

// Agent swaps only behave correctly if the widget sees its own saved agentId
// come back, which renderPin's fixed instance never does. Mirrors the merge
// updateWidgetStateMutation performs.
function renderStatefulPin() {
  const onUpdateState = vi.fn();

  function Harness() {
    const [widgetState, setWidgetState] = useState<
      Record<string, unknown> | undefined
    >(undefined);
    return (
      <PromptPinWidget
        instance={makeInstance(widgetState)}
        onUpdateState={(next) => {
          onUpdateState(next);
          setWidgetState((current) => ({ ...current, ...next }));
        }}
      />
    );
  }

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(<Harness />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
  return { onUpdateState };
}

describe("PromptPinWidget", () => {
  beforeEach(() => {
    state.personas = [persona()];
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("opens in edit mode when the prompt text is empty", () => {
    renderPin();

    expect(
      screen.getByPlaceholderText("Write a prompt to run..."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Run prompt/ }),
    ).not.toBeInTheDocument();
  });

  it("renders only the title and attached agent in ready mode", () => {
    renderPin({
      widgetState: readyState({
        title: "Daily summary",
        text: "Summarize my inbox",
        agentId: "agent-1",
      }),
    });

    const tile = screen.getByRole("button", {
      name: "Run prompt: Daily summary",
    });
    expect(tile).toHaveTextContent("Daily summary");
    expect(tile).not.toHaveTextContent("Summarize my inbox");
    expect(tile).toHaveTextContent("Agent One");
  });

  it("falls back to the first prompt line as the title", () => {
    renderPin({
      widgetState: readyState({ text: "First line\nsecond line" }),
    });

    expect(
      screen.getByRole("button", { name: "Run prompt: First line" }),
    ).toBeInTheDocument();
  });

  it("runs the prompt with text and agent id on activation", () => {
    const onRunPrompt = vi.fn();
    renderPin({
      widgetState: readyState({
        text: "Summarize my inbox",
        agentId: "agent-1",
      }),
      onRunPrompt,
    });

    fireEvent.click(screen.getByRole("button", { name: /Run prompt/ }));

    expect(onRunPrompt).toHaveBeenCalledTimes(1);
    expect(onRunPrompt).toHaveBeenCalledWith({
      text: "Summarize my inbox",
      agentId: "agent-1",
    });
  });

  it("passes the stored agent id even when the persona no longer exists", () => {
    state.personas = [];
    const onRunPrompt = vi.fn();
    renderPin({
      widgetState: readyState({
        text: "Summarize my inbox",
        agentId: "agent-gone",
      }),
      onRunPrompt,
    });

    const tile = screen.getByRole("button", { name: /Run prompt/ });
    expect(tile).not.toHaveTextContent("Agent One");
    fireEvent.click(tile);

    expect(onRunPrompt).toHaveBeenCalledWith({
      text: "Summarize my inbox",
      agentId: "agent-gone",
    });
  });

  it("omits the agent id when no agent is attached", () => {
    const onRunPrompt = vi.fn();
    renderPin({
      widgetState: readyState({ text: "Summarize my inbox" }),
      onRunPrompt,
    });

    fireEvent.click(screen.getByRole("button", { name: /Run prompt/ }));

    expect(onRunPrompt).toHaveBeenCalledWith({
      text: "Summarize my inbox",
      agentId: undefined,
    });
  });

  it("suppresses a second run while the first is still launching", async () => {
    let resolveRun: () => void = () => {};
    const onRunPrompt = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve;
        }),
    );
    renderPin({
      widgetState: readyState({ text: "Summarize my inbox" }),
      onRunPrompt,
    });

    const tile = screen.getByRole("button", { name: /Run prompt/ });
    fireEvent.click(tile);
    fireEvent.click(tile);

    expect(onRunPrompt).toHaveBeenCalledTimes(1);

    resolveRun();
    await screen.findByRole("button", { name: /Run prompt/ });
  });

  it("switches to edit mode from the edit button without running", () => {
    const onRunPrompt = vi.fn();
    const onUpdateState = vi.fn();
    renderPin({
      widgetState: readyState({ text: "Summarize my inbox" }),
      onRunPrompt,
      onUpdateState,
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit prompt" }));

    expect(onRunPrompt).not.toHaveBeenCalled();
    expect(
      screen.getByPlaceholderText("Write a prompt to run..."),
    ).toBeInTheDocument();
    // Persisted so the frame grows back to the editor profile.
    expect(onUpdateState).toHaveBeenCalledWith({ mode: "edit" });
  });

  it("persists edit mode when an empty pin is activated", () => {
    const onRunPrompt = vi.fn();
    const onUpdateState = vi.fn();
    renderPin({
      widgetState: readyState(),
      onRunPrompt,
      onUpdateState,
    });

    fireEvent.click(screen.getByRole("button", { name: /Run prompt/ }));

    expect(onRunPrompt).not.toHaveBeenCalled();
    expect(onUpdateState).toHaveBeenCalledWith({ mode: "edit" });
  });

  // The debounced text save must not be mistaken for a finished pin: the
  // catalog sizes the frame from the same mode this renders, so treating saved
  // text as ready collapsed the frame and clipped the editor mid-edit.
  it("stays in the editor for a pin with saved text but no mode", () => {
    renderPin({ widgetState: { title: "Greeting", text: "Hi" } });

    expect(
      screen.getByPlaceholderText("Write a prompt to run..."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Run prompt/ }),
    ).not.toBeInTheDocument();
  });

  // Abandoning a half-written prompt is the common case, and the right-click
  // Unpin pill is the only other way out — nothing on the card advertises it.
  it("removes the pin from the editor without saving the draft", () => {
    const onRemoveWidget = vi.fn();
    const onUpdateState = vi.fn();
    renderPin({ onRemoveWidget, onUpdateState });

    fireEvent.change(screen.getByPlaceholderText("Write a prompt to run..."), {
      target: { value: "Half-written" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove prompt" }));

    expect(onRemoveWidget).toHaveBeenCalledTimes(1);
  });

  // The collapsed card is a one-row launcher; a second control crowds it, so
  // removal stays one click behind the pencil.
  it("keeps the collapsed card free of a remove button", () => {
    renderPin({
      widgetState: readyState({ text: "Summarize my inbox" }),
      onRemoveWidget: vi.fn(),
    });

    expect(
      screen.queryByRole("button", { name: "Remove prompt" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit prompt" }),
    ).toBeInTheDocument();
  });

  it("debounces prompt edits into onUpdateState", () => {
    vi.useFakeTimers();
    try {
      const onUpdateState = vi.fn();
      renderPin({ onUpdateState });

      fireEvent.change(
        screen.getByPlaceholderText("Write a prompt to run..."),
        { target: { value: "Summarize my inbox" } },
      );

      expect(onUpdateState).not.toHaveBeenCalled();
      vi.advanceTimersByTime(400);
      expect(onUpdateState).toHaveBeenCalledWith({
        title: "",
        text: "Summarize my inbox",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes a pending edit when the widget unmounts before the debounce", () => {
    vi.useFakeTimers();
    try {
      const onUpdateState = vi.fn();
      const { unmount } = renderPin({ onUpdateState });

      fireEvent.change(
        screen.getByPlaceholderText("Write a prompt to run..."),
        { target: { value: "Summarize my inbox" } },
      );
      expect(onUpdateState).not.toHaveBeenCalled();

      // Leaving Home mid-edit unmounts the widget without firing blur, so the
      // debounce is the only thing holding the edit.
      unmount();

      expect(onUpdateState).toHaveBeenCalledWith({
        title: "",
        text: "Summarize my inbox",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not flush on unmount when nothing is pending", () => {
    const onUpdateState = vi.fn();
    const { unmount } = renderPin({
      widgetState: readyState({ text: "Summarize my inbox" }),
      onUpdateState,
    });

    unmount();

    expect(onUpdateState).not.toHaveBeenCalled();
  });

  it("saves and shows the ready tile when Done is pressed", () => {
    const onUpdateState = vi.fn();
    renderPin({ onUpdateState });

    fireEvent.change(screen.getByPlaceholderText("Write a prompt to run..."), {
      target: { value: "Summarize my inbox" },
    });
    fireEvent.change(screen.getByPlaceholderText("Title (optional)"), {
      target: { value: "Daily summary" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    // The mode is persisted alongside the text so the catalog can size the
    // frame to the ready card instead of the taller editor.
    expect(onUpdateState).toHaveBeenLastCalledWith({
      title: "Daily summary",
      text: "Summarize my inbox",
      mode: "ready",
    });
    expect(
      screen.getByRole("button", { name: "Run prompt: Daily summary" }),
    ).toBeInTheDocument();
  });

  it("disables Done while the prompt text is empty", () => {
    renderPin();

    expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
  });

  it("saves the selected agent immediately from the persona picker", async () => {
    const user = userEvent.setup();
    const onUpdateState = vi.fn();
    renderPin({ onUpdateState });

    await user.click(screen.getByRole("button", { name: /choose assistant/i }));
    await user.click(screen.getByRole("menuitem", { name: /Agent One/ }));

    expect(onUpdateState).toHaveBeenCalledWith({ agentId: "agent-1" });
  });

  it("attaches an agent from an @ mention in the prompt text", async () => {
    const user = userEvent.setup();
    const onUpdateState = vi.fn();
    renderPin({ onUpdateState });

    const textarea = screen.getByPlaceholderText("Write a prompt to run...");
    await user.type(textarea, "@Age");
    await user.click(await screen.findByRole("option", { name: /Agent One/ }));

    expect(textarea).toHaveValue("@Agent One ");
    expect(onUpdateState).toHaveBeenCalledWith({ agentId: "agent-1" });
  });

  it("accepts the highlighted @ mention with Enter", async () => {
    const user = userEvent.setup();
    const onUpdateState = vi.fn();
    renderPin({ onUpdateState });

    const textarea = screen.getByPlaceholderText("Write a prompt to run...");
    await user.type(textarea, "help me @Age");
    await screen.findByRole("option", { name: /Agent One/ });
    await user.keyboard("{Enter}");

    expect(textarea).toHaveValue("help me @Agent One ");
    expect(onUpdateState).toHaveBeenCalledWith({ agentId: "agent-1" });
  });

  it("replaces a mention it inserted instead of accumulating agents", async () => {
    state.personas = [
      persona(),
      persona({ id: "agent-2", displayName: "Agent Two" }),
    ];
    const user = userEvent.setup();
    const { onUpdateState } = renderStatefulPin();

    const textarea = screen.getByPlaceholderText("Write a prompt to run...");
    await user.type(textarea, "@Age");
    await user.click(await screen.findByRole("option", { name: /Agent One/ }));
    await user.type(textarea, "do the thing @Two");
    await user.click(await screen.findByRole("option", { name: /Agent Two/ }));

    expect(textarea).toHaveValue("do the thing @Agent Two ");
    expect(onUpdateState).toHaveBeenCalledWith({ agentId: "agent-2" });
  });

  it("keeps an authored mention of an agent attached from the picker", async () => {
    state.personas = [
      persona(),
      persona({ id: "agent-2", displayName: "Agent Two" }),
    ];
    const user = userEvent.setup();
    const { onUpdateState } = renderStatefulPin();

    await user.click(screen.getByRole("button", { name: /choose assistant/i }));
    await user.click(screen.getByRole("menuitem", { name: /Agent One/ }));

    const textarea = screen.getByPlaceholderText("Write a prompt to run...");
    await user.type(textarea, "ask @Agent One to review @Two");
    await user.click(await screen.findByRole("option", { name: /Agent Two/ }));

    // The picker inserted no mention, so this text is the user's prose.
    expect(textarea).toHaveValue("ask @Agent One to review @Agent Two ");
    expect(onUpdateState).toHaveBeenCalledWith({ agentId: "agent-2" });
  });

  it("removes nothing when the old agent is mentioned more than once", async () => {
    state.personas = [
      persona(),
      persona({ id: "agent-2", displayName: "Agent Two" }),
    ];
    const user = userEvent.setup();
    renderStatefulPin();

    const textarea = screen.getByPlaceholderText("Write a prompt to run...");
    await user.type(textarea, "@Age");
    await user.click(await screen.findByRole("option", { name: /Agent One/ }));
    // Rewrite the prompt so the inserted range no longer resolves and two
    // identical mentions compete for it.
    fireEvent.change(textarea, {
      target: { value: "ask @Agent One and @Agent One again @Two" },
    });
    await user.click(await screen.findByRole("option", { name: /Agent Two/ }));

    expect(textarea).toHaveValue(
      "ask @Agent One and @Agent One again @Agent Two ",
    );
  });
});
