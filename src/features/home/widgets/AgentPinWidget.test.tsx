import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Persona } from "@/shared/types/agents";
import type { WidgetInstance } from "./types";
import { AgentPinWidget } from "./AgentPinWidget";

const state = vi.hoisted(() => ({ personas: [] as Persona[] }));

vi.mock("@/features/agents/stores/agentStore", () => ({
  useAgentStore: (selector: (store: { personas: Persona[] }) => unknown) =>
    selector(state),
}));

const instance: WidgetInstance = {
  id: "agent-pin-1",
  type: "agentPin",
  x: 20,
  y: 30,
  z: 1,
  state: { agentId: "agent-1" },
};

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

function renderPin() {
  return render(
    <AgentPinWidget
      instance={instance}
      onUpdateState={vi.fn()}
      onOpenAgent={vi.fn()}
    />,
  );
}

describe("AgentPinWidget", () => {
  beforeEach(() => {
    state.personas = [persona()];
    vi.clearAllMocks();
  });

  it.each([
    ["remote", "https://example.test/scout.png", 'img[src$="scout.png"]'],
    ["bundled", "app-avatar:gloopy-1", "video"],
  ])("renders %s avatars as a transparent visual tile", (_, avatar, media) => {
    state.personas = [persona({ avatar })];

    const { container } = renderPin();
    const button = screen.getByRole("button", { name: "Open Agent One" });

    expect(button).toHaveClass("bg-transparent");
    expect(button).not.toHaveClass("bg-surface-card");
    expect(screen.getByText("Agent One")).toBeInTheDocument();
    expect(container.querySelector(media)).toBeInTheDocument();
    expect(screen.queryByText("Agent")).not.toBeInTheDocument();
  });

  it("keeps the compact text card fallback without an avatar", () => {
    renderPin();

    expect(screen.getByRole("button", { name: "Open Agent One" })).toHaveClass(
      "h-24",
      "w-[200px]",
      "bg-surface-card",
    );
    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.getByText("Agent One")).toBeInTheDocument();
  });
});
