import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("clicking detail edit calls onStartAgentBuilderSession with the source slug", () => {
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
      slug: "code-reviewer",
    });
  });
});
