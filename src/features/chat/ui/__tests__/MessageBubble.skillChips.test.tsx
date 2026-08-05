import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageBubble } from "../MessageBubble";
import type { Message } from "@/shared/types/messages";
import { useAgentStore } from "@/features/agents/stores/agentStore";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
}));

function userMessage(text: string, overrides: Partial<Message> = {}): Message {
  return {
    id: "u1",
    role: "user",
    created: Date.now(),
    content: [{ type: "text", text }],
    ...overrides,
  };
}

describe("MessageBubble skill chips", () => {
  it("renders user message chips from metadata", () => {
    const { container } = render(
      <MessageBubble
        message={userMessage("redo the settings modal", {
          metadata: {
            chips: [{ label: "capture-task", type: "skill" }],
          },
        })}
      />,
    );

    expect(screen.getByText("capture-task")).toBeInTheDocument();
    expect(
      container.querySelector('[data-role="user-message-content"]'),
    ).toHaveTextContent("redo the settings modal");
    expect(screen.queryByText(/Use the capture-task skill/i)).toBeNull();
  });

  it("renders multiple user message agent chips from metadata", () => {
    const { container } = render(
      <MessageBubble
        message={userMessage("compare approaches", {
          metadata: {
            chips: [
              { label: "Reviewer", agentRole: "mentioned", type: "agent" },
              { label: "Solo", agentRole: "active", type: "agent" },
            ],
          },
        })}
      />,
    );

    expect(screen.getByText("@Reviewer")).toBeInTheDocument();
    expect(screen.getByText("Solo")).toBeInTheDocument();
    expect(
      container.querySelector('[data-role="user-message-content"]'),
    ).toHaveTextContent("compare approaches");
  });

  it("renders agent chip avatars from persona metadata", () => {
    useAgentStore.setState({
      personas: [
        {
          id: "reviewer",
          displayName: "Reviewer",
          avatar: "https://example.test/reviewer.png",
          systemPrompt: "",
          isBuiltin: false,
          writable: true,
        },
      ],
    });
    const { container } = render(
      <MessageBubble
        message={userMessage("take a look", {
          metadata: {
            chips: [
              {
                id: "reviewer",
                label: "Reviewer",
                agentRole: "active",
                type: "agent",
              },
            ],
          },
        })}
      />,
    );

    expect(screen.getByText("Reviewer")).toBeInTheDocument();
    expect(
      container.querySelector('img[src="https://example.test/reviewer.png"]'),
    ).toBeInTheDocument();
  });
});
