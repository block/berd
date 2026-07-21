import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { CSSProperties } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatRightRail } from "../ChatRightRail";

const mocks = vi.hoisted(() => ({
  patchSession: vi.fn(),
  setPersonas: vi.fn(),
  listPersonas: vi.fn(),
  recoverDraftAgent: vi.fn(),
  setAgentBuilderSessionLocalEdits: vi.fn(),
  setAgentBuilderSessionSaveHandler: vi.fn(),
  rightRailOpen: false,
  compactViewport: false,
  reducedMotion: false,
}));

vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  return {
    ...actual,
    useReducedMotion: () => mocks.reducedMotion,
  };
});

vi.mock("@/features/agents/ui/AgentBuilderRail", () => ({
  AGENT_BUILDER_RAIL_WIDTH: 506,
  AgentBuilderRail: (props: {
    targetAgentPath?: string | null;
    targetAgentSlug?: string | null;
    draftState?: "preparing" | "failed" | null;
    onDraftPromoted?: (source: unknown) => void;
    onDraftTargetChanged?: (target: { path: string; slug: string }) => void;
    onRecoverMissingDraft?: () => void;
    onClose?: () => void;
    onLocalEditStateChange?: (hasLocalEdits: boolean) => void;
    onSaveDraftHandlerChange?: (
      saveDraft: (() => boolean | Promise<boolean>) | null,
    ) => void;
  }) => (
    <div data-testid="agent-builder-rail">
      <span data-testid="agent-builder-target">
        {props.targetAgentPath ?? "pending"}
      </span>
      <span data-testid="agent-builder-draft-state">
        {props.draftState ?? "ready"}
      </span>
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
      <button type="button" onClick={props.onClose}>
        close
      </button>
      <button
        type="button"
        onClick={() => props.onLocalEditStateChange?.(true)}
      >
        local edits
      </button>
      <button
        type="button"
        onClick={() => props.onSaveDraftHandlerChange?.(() => true)}
      >
        register save draft
      </button>
    </div>
  ),
}));

vi.mock("@/features/agents/lib/agentBuilderSession", () => ({
  recoverPendingDraftAgent: (...args: unknown[]) =>
    mocks.recoverDraftAgent(...args),
  setAgentBuilderSessionLocalEdits: (...args: unknown[]) =>
    mocks.setAgentBuilderSessionLocalEdits(...args),
  setAgentBuilderSessionSaveHandler: (...args: unknown[]) =>
    mocks.setAgentBuilderSessionSaveHandler(...args),
}));

vi.mock("@/features/agents/stores/agentStore", () => ({
  useAgentStore: {
    getState: () => ({ setPersonas: mocks.setPersonas }),
  },
}));

vi.mock("@/shared/api/agents", () => ({
  listPersonas: () => mocks.listPersonas(),
}));

vi.mock("../../hooks/useGitStateAutoRefresh", () => ({
  useGitStateAutoRefreshOnChatSettled: vi.fn(),
}));

vi.mock("@/features/terminal/capabilities/TerminalCapability", () => ({
  TerminalCapability: () => <div data-testid="rail-terminal">Terminal</div>,
}));

vi.mock("../ChatContextPanel", () => ({
  CP_TOTAL_W: 339,
  ChatContextPanel: ({
    isVisible,
    elevated,
  }: {
    isVisible: boolean;
    elevated?: boolean;
  }) =>
    isVisible ? (
      <button type="button" data-elevated={elevated ? "true" : "false"}>
        Context content
      </button>
    ) : null,
  useChatContextPanelCompactViewport: () => mocks.compactViewport,
}));

vi.mock("../../stores/chatSessionStore", () => ({
  useChatSessionStore: (
    selector: (state: {
      isRightRailOpen: boolean;
      patchSession: typeof mocks.patchSession;
    }) => unknown,
  ) =>
    selector({
      isRightRailOpen: mocks.rightRailOpen,
      patchSession: mocks.patchSession,
    }),
}));

describe("ChatRightRail", () => {
  beforeEach(() => {
    mocks.rightRailOpen = false;
    mocks.compactViewport = false;
    mocks.reducedMotion = false;
    mocks.patchSession.mockReset();
    mocks.setPersonas.mockReset();
    mocks.listPersonas.mockReset();
    mocks.listPersonas.mockResolvedValue([]);
    mocks.recoverDraftAgent.mockReset();
    mocks.recoverDraftAgent.mockResolvedValue({
      path: "/Users/x/.agents/agents/recovered.md",
      slug: "recovered",
    });
    mocks.setAgentBuilderSessionLocalEdits.mockReset();
    mocks.setAgentBuilderSessionSaveHandler.mockReset();
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
    expect(screen.getByTestId("agent-builder-target")).toHaveTextContent(
      "/path",
    );
    expect(
      screen.queryByRole("button", { name: "Context content" }),
    ).toBeNull();
    expect(screen.getByTestId("agent-builder-rail").parentElement).toHaveStyle({
      width: "min(506px, calc((100vw - 0px) / 2))",
    });
  });

  it("renders AgentBuilderRail for provisional build-agent sessions", () => {
    render(
      <ChatRightRail
        session={
          {
            id: "s1",
            intent: "build-agent",
            targetAgentPath: null,
            targetAgentSlug: null,
            targetAgentDraftState: "preparing",
          } as never
        }
      />,
    );

    expect(screen.getByTestId("agent-builder-rail")).toBeTruthy();
    expect(screen.getByTestId("agent-builder-target")).toHaveTextContent(
      "pending",
    );
    expect(screen.getByTestId("agent-builder-draft-state")).toHaveTextContent(
      "preparing",
    );
    expect(
      screen.queryByRole("button", { name: "Context content" }),
    ).toBeNull();
  });

  it("applies builder column entrance props to the build-agent rail shell", () => {
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
        builderColumnClassName="agent-builder-column-enter"
        builderColumnStyle={
          {
            "--agent-builder-column-enter-delay": "130ms",
          } as CSSProperties
        }
      />,
    );

    const shell = screen.getByTestId("agent-builder-rail").parentElement;
    expect(shell).toHaveClass("agent-builder-column-enter");
    expect(
      shell?.style.getPropertyValue("--agent-builder-column-enter-delay"),
    ).toBe("130ms");
  });

  it("renders context inside an open rail", () => {
    mocks.rightRailOpen = true;
    render(
      <ChatRightRail
        session={{ id: "s2", intent: null } as never}
        project={null}
        sessionWorkingDir={null}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Context content" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("agent-builder-rail")).toBeNull();
  });

  it("gives the whole rail a usable overlay width in compact mode", () => {
    mocks.rightRailOpen = true;
    mocks.compactViewport = true;
    const { container } = render(
      <ChatRightRail session={{ id: "s2", intent: null } as never} />,
    );

    expect(container.querySelector("[data-chat-right-rail]")).toHaveStyle({
      width: "0px",
    });
    const overlay = container.querySelector("[data-right-rail-surface]");
    expect(overlay).toHaveStyle({
      width: "min(339px, calc(100vw - 1.5rem))",
    });
    expect(overlay).not.toHaveClass(
      "overflow-hidden",
      "rounded-md",
      "shadow-popover",
    );
    expect(
      screen.getByRole("button", { name: "Context content" }),
    ).toHaveAttribute("data-elevated", "true");
  });

  it("keeps context and terminal as separate elevated panels in overlay mode", () => {
    mocks.rightRailOpen = true;
    mocks.compactViewport = true;
    const terminalController = {
      visible: true,
      expanded: true,
      placement: {
        kind: "docked",
        region: "rightRail",
        slot: "belowContext",
        size: { height: 300 },
      },
    } as never;
    const { container } = render(
      <ChatRightRail
        session={{ id: "s2", intent: null } as never}
        terminalController={terminalController}
        terminalRootRef={{ current: null }}
      />,
    );

    const surface = container.querySelector("[data-right-rail-surface]");
    const terminalPanel = screen.getByTestId("rail-terminal").parentElement;
    expect(surface).not.toHaveClass("overflow-hidden", "shadow-popover");
    expect(
      screen.getByRole("button", { name: "Context content" }),
    ).toHaveAttribute("data-elevated", "true");
    expect(terminalPanel).toHaveClass(
      "overflow-hidden",
      "rounded-md",
      "shadow-popover",
    );
  });

  it("previews the full rail as an overlay when docking into a closed rail", () => {
    mocks.compactViewport = false;
    const { container } = render(
      <ChatRightRail
        session={{ id: "s2", intent: null } as never}
        terminalDockPreview={{
          kind: "docked",
          region: "rightRail",
          slot: "belowContext",
          size: { height: 300 },
        }}
      />,
    );

    expect(container.querySelector("[data-chat-right-rail]")).toHaveStyle({
      width: "0px",
    });
    expect(
      screen.getByRole("button", { name: "Context content" }),
    ).toBeVisible();
    expect(
      container.querySelector("[data-terminal-rail-dock-preview]"),
    ).toBeInTheDocument();
    const previewSurface = container.querySelector("[data-right-rail-surface]");
    expect(container.querySelector("[data-chat-right-rail]")).toHaveClass(
      "overflow-visible",
    );
    expect(previewSurface).toHaveClass("absolute", "right-0");
    expect(previewSurface).toHaveStyle({
      width: "min(339px, calc(100vw - 1.5rem))",
    });
  });

  it("skips the docking handoff when reduced motion is requested", () => {
    mocks.rightRailOpen = true;
    mocks.compactViewport = true;
    mocks.reducedMotion = true;
    const { container, rerender } = render(
      <ChatRightRail session={{ id: "s2", intent: null } as never} />,
    );

    mocks.compactViewport = false;
    rerender(<ChatRightRail session={{ id: "s2", intent: null } as never} />);

    expect(container.querySelector("[data-chat-right-rail]")).toHaveStyle({
      transition: "none",
    });
    expect(
      container.querySelector("[data-right-rail-surface]"),
    ).not.toHaveClass("absolute");
  });

  it("keeps the rail surface floating while the chat slides left into docked layout", () => {
    vi.useFakeTimers();
    mocks.rightRailOpen = true;
    mocks.compactViewport = true;
    const { container, rerender } = render(
      <ChatRightRail session={{ id: "s2", intent: null } as never} />,
    );

    mocks.compactViewport = false;
    rerender(<ChatRightRail session={{ id: "s2", intent: null } as never} />);

    const rail = container.querySelector("[data-chat-right-rail]");
    const surface = container.querySelector("[data-right-rail-surface]");
    expect(rail).toHaveStyle({ width: "339px" });
    expect(rail).toHaveClass("overflow-visible");
    expect(rail).not.toHaveClass("overflow-hidden");
    expect(surface).toHaveClass("absolute", "right-0", "top-0");
    expect(surface).not.toHaveClass("shadow-popover");

    act(() => vi.advanceTimersByTime(200));
    expect(rail).toHaveClass("overflow-hidden");
    expect(surface).not.toHaveClass("absolute");
    vi.useRealTimers();
  });

  it("hides a rail-docked terminal when the rail closes without changing its controller", () => {
    const terminalController = {
      visible: true,
      expanded: true,
      placement: {
        kind: "docked",
        region: "rightRail",
        slot: "belowContext",
        size: { height: 300 },
      },
    } as never;
    const terminalRootRef = { current: null };

    const { rerender } = render(
      <ChatRightRail
        session={{ id: "s2", intent: null } as never}
        terminalController={terminalController}
        terminalRootRef={terminalRootRef}
      />,
    );
    expect(screen.getByTestId("rail-terminal")).toBeInTheDocument();
    expect(
      screen.getByTestId("rail-terminal").closest("[data-chat-right-rail]"),
    ).toHaveAttribute("aria-hidden", "true");

    mocks.rightRailOpen = true;
    rerender(
      <ChatRightRail
        session={{ id: "s2", intent: null } as never}
        terminalController={terminalController}
        terminalRootRef={terminalRootRef}
      />,
    );
    expect(screen.getByTestId("rail-terminal")).toBeVisible();
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
        targetAgentDraftState: null,
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
      targetAgentDraftState: null,
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
      expect(mocks.patchSession).toHaveBeenCalledWith("s1", {
        targetAgentDraftState: "preparing",
      });
      expect(mocks.recoverDraftAgent).toHaveBeenCalledWith("s1", "/path");
      expect(mocks.patchSession).toHaveBeenCalledWith("s1", {
        intent: "build-agent",
        targetAgentPath: "/Users/x/.agents/agents/recovered.md",
        targetAgentSlug: "recovered",
        targetAgentDraftState: null,
      });
    });
  });

  it("notifies the parent when the builder close action fires", () => {
    const onAgentBuilderClose = vi.fn();
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
        onAgentBuilderClose={onAgentBuilderClose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "close" }));

    expect(onAgentBuilderClose).toHaveBeenCalledTimes(1);
  });

  it("tracks local edit state for the builder session", () => {
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

    fireEvent.click(screen.getByRole("button", { name: "local edits" }));

    expect(mocks.setAgentBuilderSessionLocalEdits).toHaveBeenCalledWith(
      "s1",
      true,
    );
  });

  it("registers a save handler for the builder session", () => {
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

    fireEvent.click(
      screen.getByRole("button", { name: "register save draft" }),
    );

    expect(mocks.setAgentBuilderSessionSaveHandler).toHaveBeenCalledWith(
      "s1",
      expect.any(Function),
    );
  });
});
