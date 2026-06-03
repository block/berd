import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { AgentsView } from "../AgentsView";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@/features/agents/hooks/usePersonas", () => ({
  usePersonas: () => ({
    createPersona: vi.fn(),
    deletePersona: vi.fn(),
    refreshFromDisk: vi.fn(),
  }),
}));

const persona = {
  id: "/Users/x/.agents/agents/code-reviewer.md",
  displayName: "Code reviewer",
  systemPrompt: "Review code carefully.",
  isBuiltin: false,
  writable: true,
};

describe("AgentsView entry points", () => {
  const originalMatchMedia = window.matchMedia;
  const originalStartViewTransition = (
    document as Document & {
      startViewTransition?: (callback: () => void) => unknown;
    }
  ).startViewTransition;

  afterEach(() => {
    if (originalStartViewTransition) {
      Object.defineProperty(document, "startViewTransition", {
        configurable: true,
        value: originalStartViewTransition,
      });
    } else {
      Reflect.deleteProperty(document, "startViewTransition");
    }
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
    delete document.documentElement.dataset.agentTransition;
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    useAgentStore.setState({
      personas: [],
      personasLoading: false,
      providers: [],
    });
  });

  it("clicking Create calls onStartAgentBuilderSession", () => {
    const onStartAgentBuilderSession = vi.fn();
    render(
      <AgentsView onStartAgentBuilderSession={onStartAgentBuilderSession} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "gallery.createAria" }));

    expect(onStartAgentBuilderSession).toHaveBeenCalledWith({});
  });

  it("clicking detail Start chat calls onStartChatWithAgent with the persona id", () => {
    const onStartChatWithAgent = vi.fn();
    useAgentStore.setState({ personas: [persona] });

    render(
      <AgentsView
        activePersonaId={persona.id}
        onStartChatWithAgent={onStartChatWithAgent}
      />,
    );

    const startChatButton = screen.getByRole("button", {
      name: "detail.startChat",
    });
    expect(startChatButton).toHaveClass("bg-surface-agent-profile-control-bg");

    fireEvent.click(startChatButton);

    expect(onStartChatWithAgent).toHaveBeenCalledWith(persona.id);
  });

  it("clicking detail edit calls onStartAgentBuilderSession with the source path and slug", () => {
    const onStartAgentBuilderSession = vi.fn();
    useAgentStore.setState({ personas: [persona] });

    render(
      <AgentsView
        activePersonaId={persona.id}
        onStartAgentBuilderSession={onStartAgentBuilderSession}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "common:actions.edit" }),
    );

    expect(onStartAgentBuilderSession).toHaveBeenCalledWith({
      path: "/Users/x/.agents/agents/code-reviewer.md",
      slug: "code-reviewer",
    });
  });

  it("starts a gallery-to-profile view transition when opening detail", () => {
    const resolved = Promise.resolve();
    const startViewTransition = vi.fn((callback: () => void) => {
      expect(document.documentElement.dataset.agentTransition).toBe(
        "gallery-to-profile",
      );
      callback();
      return {
        finished: resolved,
        ready: resolved,
        updateCallbackDone: resolved,
        skipTransition: vi.fn(),
      };
    });
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: startViewTransition,
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
    useAgentStore.setState({ personas: [persona] });

    render(<AgentsView />);

    fireEvent.click(screen.getByRole("button", { name: "card.viewAria" }));

    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("heading", { name: persona.displayName }),
    ).toBeInTheDocument();
  });
});
