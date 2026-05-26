import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatRightRail } from "../ChatRightRail";

const mocks = vi.hoisted(() => ({
  patchSession: vi.fn(),
  setPersonas: vi.fn(),
  listPersonas: vi.fn(),
  recoverDraftAgent: vi.fn(),
}));

vi.mock("@/features/agents/ui/AgentBuilderRail", () => ({
  AgentBuilderRail: (props: {
    onDraftPromoted?: (source: unknown) => void;
    onDraftTargetChanged?: (target: { path: string; slug: string }) => void;
    onRecoverMissingDraft?: () => void;
  }) => (
    <div data-testid="agent-builder-rail">
      <button
        type="button"
        onClick={() => props.onDraftPromoted?.({ path: "/path" })}
      >
        promote
      </button>
      <button
        type="button"
        onClick={() =>
          props.onDraftTargetChanged?.({
            path: "/Users/x/.agents/agents/moved.md",
            slug: "moved",
          })
        }
      >
        target changed
      </button>
      <button type="button" onClick={props.onRecoverMissingDraft}>
        recover
      </button>
    </div>
  ),
}));

vi.mock("@/features/agents/lib/agentBuilderSession", () => ({
  recoverDraftAgent: (...args: unknown[]) => mocks.recoverDraftAgent(...args),
}));

vi.mock("@/features/agents/stores/agentStore", () => ({
  useAgentStore: {
    getState: () => ({ setPersonas: mocks.setPersonas }),
  },
}));

vi.mock("@/shared/api/agents", () => ({
  listPersonas: () => mocks.listPersonas(),
}));

vi.mock("../ChatContextPanel", () => ({
  CP_TOTAL_W: 339,
  ChatContextPanel: () => <div data-testid="chat-context-panel" />,
}));

vi.mock("../../stores/chatSessionStore", () => ({
  useChatSessionStore: (
    selector: (state: {
      isContextPanelOpen: boolean;
      patchSession: typeof mocks.patchSession;
    }) => unknown,
  ) =>
    selector({ isContextPanelOpen: false, patchSession: mocks.patchSession }),
}));

describe("ChatRightRail", () => {
  beforeEach(() => {
    mocks.patchSession.mockReset();
    mocks.setPersonas.mockReset();
    mocks.listPersonas.mockReset();
    mocks.listPersonas.mockResolvedValue([]);
    mocks.recoverDraftAgent.mockReset();
    mocks.recoverDraftAgent.mockResolvedValue({
      path: "/Users/x/.agents/agents/recovered.md",
      slug: "recovered",
    });
  });

  it("renders AgentBuilderRail for build-agent sessions", () => {
    render(
      <ChatRightRail
        session={
          {
            id: "s1",
            intent: "build-agent",
            targetAgentPath: "/path",
            targetAgentSlug: "draft-s1",
          } as never
        }
      />,
    );

    expect(screen.getByTestId("agent-builder-rail")).toBeTruthy();
    expect(screen.queryByTestId("chat-context-panel")).toBeNull();
    expect(screen.getByTestId("agent-builder-rail").parentElement).toHaveStyle({
      width: "509px",
    });
  });

  it("renders ChatContextPanel for normal sessions", () => {
    render(
      <ChatRightRail
        session={{ id: "s2", intent: null } as never}
        project={null}
        sessionWorkingDir={null}
      />,
    );

    expect(screen.getByTestId("chat-context-panel")).toBeTruthy();
    expect(screen.queryByTestId("agent-builder-rail")).toBeNull();
  });

  it("refreshes agents and notifies the app shell when a draft is promoted", async () => {
    const onDraftPromoted = vi.fn();
    const personas = [{ id: "/path", displayName: "Snark" }];
    mocks.listPersonas.mockResolvedValue(personas);

    render(
      <ChatRightRail
        session={
          {
            id: "s1",
            intent: "build-agent",
            targetAgentPath: "/path",
            targetAgentSlug: "draft-s1",
          } as never
        }
        onDraftPromoted={onDraftPromoted}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "promote" }));

    await waitFor(() => {
      expect(mocks.patchSession).toHaveBeenCalledWith("s1", {
        intent: null,
        targetAgentPath: null,
        targetAgentSlug: null,
      });
      expect(mocks.setPersonas).toHaveBeenCalledWith(personas);
      expect(onDraftPromoted).toHaveBeenCalledWith({ path: "/path" });
    });
  });

  it("patches only chat session target fields when the draft target moves", () => {
    render(
      <ChatRightRail
        session={
          {
            id: "s1",
            intent: "build-agent",
            targetAgentPath: "/path",
            targetAgentSlug: "draft-s1",
          } as never
        }
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "target changed" }));

    expect(mocks.patchSession).toHaveBeenCalledWith("s1", {
      targetAgentPath: "/Users/x/.agents/agents/moved.md",
      targetAgentSlug: "moved",
    });
  });

  it("recovers a missing draft by pre-seeding and patching the chat session", async () => {
    render(
      <ChatRightRail
        session={
          {
            id: "s1",
            intent: "build-agent",
            targetAgentPath: "/path",
            targetAgentSlug: "draft-s1",
          } as never
        }
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "recover" }));

    await waitFor(() => {
      expect(mocks.recoverDraftAgent).toHaveBeenCalledWith("s1", "/path");
      expect(mocks.patchSession).toHaveBeenCalledWith("s1", {
        intent: "build-agent",
        targetAgentPath: "/Users/x/.agents/agents/recovered.md",
        targetAgentSlug: "recovered",
      });
    });
  });
});
