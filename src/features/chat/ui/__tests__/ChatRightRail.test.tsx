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
  addPersona: vi.fn(),
  updatePersona: vi.fn(),
  personas: [] as Array<{ id: string }>,
  listPersonas: vi.fn(),
  recoverDraftAgent: vi.fn(),
  setAgentBuilderSessionLocalEdits: vi.fn(),
  setAgentBuilderSessionSaveHandler: vi.fn(),
  saveDraftAgentSession: vi.fn(),
  clearBuilderSessionState: vi.fn(),
  toastError: vi.fn(),
  rightRailOpen: false,
  compactViewport: false,
  reducedMotion: false,
}));

vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => mocks.toastError(...args) },
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
    onAgentBuilderCompleted?: (agentId: string) => void;
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
        onClick={() => {
          props.onDraftPromoted?.({ path: "/path" });
        }}
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
  clearBuilderSessionState: (...args: unknown[]) =>
    mocks.clearBuilderSessionState(...args),
  recoverPendingDraftAgent: (...args: unknown[]) =>
    mocks.recoverDraftAgent(...args),
  setAgentBuilderSessionLocalEdits: (...args: unknown[]) =>
    mocks.setAgentBuilderSessionLocalEdits(...args),
  setAgentBuilderSessionSaveHandler: (...args: unknown[]) =>
    mocks.setAgentBuilderSessionSaveHandler(...args),
  saveDraftAgentSession: (...args: unknown[]) =>
    mocks.saveDraftAgentSession(...args),
}));

vi.mock("@/features/agents/stores/agentStore", () => ({
  useAgentStore: {
    getState: () => ({
      personas: mocks.personas,
      setPersonas: mocks.setPersonas,
      addPersona: mocks.addPersona,
      updatePersona: mocks.updatePersona,
    }),
  },
}));

vi.mock("@/shared/api/agents", () => ({
  agentSourceToPersona: (source: {
    path: string;
    name?: string;
    description?: string;
    content?: string;
  }) => ({
    id: source.path,
    displayName: source.name ?? "Saved agent",
    sourceDescription: source.description,
    systemPrompt: source.content ?? "",
    isBuiltin: false,
    writable: true,
  }),
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
    mocks.personas = [];
    mocks.setPersonas.mockReset();
    mocks.addPersona.mockReset();
    mocks.updatePersona.mockReset();
    mocks.listPersonas.mockReset();
    mocks.listPersonas.mockResolvedValue([]);
    mocks.recoverDraftAgent.mockReset();
    mocks.recoverDraftAgent.mockResolvedValue({
      path: "/Users/x/.agents/agents/recovered.md",
      slug: "recovered",
    });
    mocks.setAgentBuilderSessionLocalEdits.mockReset();
    mocks.setAgentBuilderSessionSaveHandler.mockReset();
    mocks.saveDraftAgentSession.mockReset();
    mocks.saveDraftAgentSession.mockResolvedValue(undefined);
    mocks.clearBuilderSessionState.mockReset();
    mocks.toastError.mockReset();
  });

  it("renders Agent Builder without opening Context", () => {
    render(
      <ChatRightRail
        contextVisible={mocks.rightRailOpen}
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
    // ChatView owns the grid width now; the builder cell must not pin its own
    // inline width and should fill its track (min-w-0).
    const builderCell = screen.getByTestId("agent-builder-rail").parentElement;
    expect(builderCell?.style.width).toBe("");
    expect(builderCell?.className).toContain("min-w-0");
  });

  it("renders the builder resize divider when the chat is not collapsed", () => {
    const onPointerDown = vi.fn();
    const onKeyDown = vi.fn();
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
        contextVisible={false}
        builderRailSeparatorProps={{
          role: "separator",
          tabIndex: 0,
          "aria-orientation": "vertical",
          "aria-valuenow": 50,
          "aria-valuemin": 30,
          "aria-valuemax": 72,
          onPointerDown,
          onKeyDown,
        }}
      />,
    );

    const divider = document.querySelector(
      "[data-agent-builder-rail-resize-edge]",
    );
    expect(divider).not.toBeNull();
    // Keyboard reachability is the point of the separator role, so assert the
    // exposed semantics rather than just the pointer path.
    expect(divider).toHaveAttribute("role", "separator");
    expect(divider).toHaveAttribute("tabindex", "0");
    expect(divider).toHaveAttribute("aria-valuenow", "50");
    fireEvent.pointerDown(divider as Element);
    expect(onPointerDown).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(divider as Element, { key: "ArrowLeft" });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  it("hides the builder resize divider when the chat is collapsed", () => {
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
        contextVisible={false}
        agentBuilderChatCollapsed
        builderRailSeparatorProps={{
          role: "separator",
          tabIndex: 0,
          "aria-orientation": "vertical",
          "aria-valuenow": 50,
          "aria-valuemin": 30,
          "aria-valuemax": 72,
          onPointerDown: vi.fn(),
          onKeyDown: vi.fn(),
        }}
      />,
    );

    expect(
      document.querySelector("[data-agent-builder-rail-resize-edge]"),
    ).toBeNull();
  });

  it("lets Context and a rail-docked Terminal coexist with Agent Builder", () => {
    mocks.rightRailOpen = true;
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

    render(
      <ChatRightRail
        contextVisible={mocks.rightRailOpen}
        session={
          {
            id: "s1",
            intent: "build-agent",
            agentBuilderOpen: true,
            targetAgentPath: "/path",
            targetAgentSlug: "draft-s1",
          } as never
        }
        terminalController={terminalController}
        terminalRootRef={{ current: null }}
      />,
    );

    expect(screen.getByTestId("agent-builder-rail")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Context content" }),
    ).toBeVisible();
    expect(screen.getByTestId("rail-terminal")).toBeVisible();
  });

  it("overlays Context and its Terminal beside Agent Builder in compact layouts", () => {
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
        contextVisible={mocks.rightRailOpen}
        session={
          {
            id: "s1",
            intent: "build-agent",
            agentBuilderOpen: true,
            targetAgentPath: "/path",
            targetAgentSlug: "draft-s1",
          } as never
        }
        terminalController={terminalController}
        terminalRootRef={{ current: null }}
      />,
    );

    expect(screen.getByTestId("agent-builder-rail")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Context content" }),
    ).toHaveAttribute("data-elevated", "true");
    expect(screen.getByTestId("rail-terminal")).toBeVisible();
    expect(container.querySelector("[data-right-rail-surface]")).toHaveClass(
      "absolute",
    );
  });

  it("keeps a rail-docked Terminal visible when Context is closed", () => {
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

    render(
      <ChatRightRail
        contextVisible={mocks.rightRailOpen}
        session={
          {
            id: "s1",
            intent: "build-agent",
            agentBuilderOpen: true,
            targetAgentPath: "/path",
            targetAgentSlug: "draft-s1",
          } as never
        }
        terminalController={terminalController}
        terminalRootRef={{ current: null }}
      />,
    );

    expect(screen.getByTestId("agent-builder-rail")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Context content" }),
    ).toBeNull();
    expect(screen.getByTestId("rail-terminal")).toBeVisible();
  });

  it("does not mount an editable Agent Builder in read-only chat windows", () => {
    render(
      <ChatRightRail
        contextVisible={mocks.rightRailOpen}
        session={
          {
            id: "s1",
            intent: "build-agent",
            agentBuilderOpen: true,
            targetAgentPath: "/path",
            targetAgentSlug: "draft-s1",
          } as never
        }
        agentBuilderReadOnly
      />,
    );

    expect(screen.queryByTestId("agent-builder-rail")).toBeNull();
  });

  it("renders AgentBuilderRail for provisional build-agent sessions", () => {
    render(
      <ChatRightRail
        contextVisible={mocks.rightRailOpen}
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
        contextVisible={mocks.rightRailOpen}
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
        contextVisible={mocks.rightRailOpen}
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
      <ChatRightRail
        contextVisible={mocks.rightRailOpen}
        session={{ id: "s2", intent: null } as never}
      />,
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
        contextVisible={mocks.rightRailOpen}
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
        contextVisible={mocks.rightRailOpen}
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
      <ChatRightRail
        contextVisible={mocks.rightRailOpen}
        session={{ id: "s2", intent: null } as never}
      />,
    );

    mocks.compactViewport = false;
    rerender(
      <ChatRightRail
        contextVisible={mocks.rightRailOpen}
        session={{ id: "s2", intent: null } as never}
      />,
    );

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
      <ChatRightRail
        contextVisible={mocks.rightRailOpen}
        session={{ id: "s2", intent: null } as never}
      />,
    );

    mocks.compactViewport = false;
    rerender(
      <ChatRightRail
        contextVisible={mocks.rightRailOpen}
        session={{ id: "s2", intent: null } as never}
      />,
    );

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

  it("keeps a rail-docked terminal visible when Context closes", () => {
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
        contextVisible={mocks.rightRailOpen}
        session={{ id: "s2", intent: null } as never}
        terminalController={terminalController}
        terminalRootRef={terminalRootRef}
      />,
    );
    expect(screen.getByTestId("rail-terminal")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Context content" }),
    ).toBeNull();

    mocks.rightRailOpen = true;
    rerender(
      <ChatRightRail
        contextVisible={mocks.rightRailOpen}
        session={{ id: "s2", intent: null } as never}
        terminalController={terminalController}
        terminalRootRef={terminalRootRef}
      />,
    );
    expect(screen.getByTestId("rail-terminal")).toBeVisible();
  });

  it("refreshes agents, closes the capability, and opens the saved agent when a draft is promoted", async () => {
    const personas = [{ id: "/path", displayName: "Snark" }];
    const onAgentBuilderCompleted = vi.fn();
    mocks.listPersonas.mockResolvedValue(personas);

    render(
      <ChatRightRail
        contextVisible={mocks.rightRailOpen}
        session={
          {
            id: "s1",
            intent: "build-agent",
            targetAgentPath: "/path",
            targetAgentSlug: "draft-s1",
          } as never
        }
        onAgentBuilderCompleted={onAgentBuilderCompleted}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "promote" }));

    expect(mocks.clearBuilderSessionState).toHaveBeenCalledWith("s1");
    expect(mocks.addPersona).toHaveBeenCalledWith(
      expect.objectContaining({ id: "/path" }),
    );
    expect(onAgentBuilderCompleted).toHaveBeenCalledWith("/path");
    await waitFor(() => {
      expect(mocks.setPersonas).toHaveBeenCalledWith(personas);
    });
  });

  it("opens the promoted agent even when refreshing agents fails", async () => {
    const onAgentBuilderCompleted = vi.fn();
    mocks.listPersonas.mockRejectedValue(new Error("refresh unavailable"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    render(
      <ChatRightRail
        contextVisible={false}
        session={
          {
            id: "s1",
            intent: "build-agent",
            targetAgentPath: "/draft-path",
            targetAgentSlug: "draft-s1",
          } as never
        }
        onAgentBuilderCompleted={onAgentBuilderCompleted}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "promote" }));

    expect(mocks.addPersona).toHaveBeenCalledWith(
      expect.objectContaining({ id: "/path" }),
    );
    expect(onAgentBuilderCompleted).toHaveBeenCalledWith("/path");
    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to refresh agents after save:",
        expect.any(Error),
      );
    });
    consoleError.mockRestore();
  });

  it("patches only chat session target fields when the draft target moves", () => {
    render(
      <ChatRightRail
        contextVisible={mocks.rightRailOpen}
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
        contextVisible={mocks.rightRailOpen}
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
        agentBuilderOpen: true,
        targetAgentPath: "/Users/x/.agents/agents/recovered.md",
        targetAgentSlug: "recovered",
        targetAgentDraftState: null,
      });
    });
  });

  it("saves and closes the capability without archiving the chat", async () => {
    render(
      <ChatRightRail
        contextVisible={mocks.rightRailOpen}
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

    fireEvent.click(screen.getByRole("button", { name: "close" }));

    await waitFor(() => {
      expect(mocks.saveDraftAgentSession).toHaveBeenCalledWith("s1");
      expect(mocks.patchSession).toHaveBeenCalledWith("s1", {
        agentBuilderOpen: false,
        agentBuilderContextState: undefined,
      });
    });
  });

  it("keeps Agent Builder open and reports an error when closing cannot save", async () => {
    mocks.saveDraftAgentSession.mockRejectedValue(new Error("disk full"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    render(
      <ChatRightRail
        contextVisible={mocks.rightRailOpen}
        session={
          {
            id: "s1",
            intent: "build-agent",
            agentBuilderOpen: true,
            targetAgentPath: "/path",
            targetAgentSlug: "draft-s1",
          } as never
        }
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "close" }));

    await waitFor(() => {
      expect(mocks.saveDraftAgentSession).toHaveBeenCalledWith("s1");
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Save failed. Your edits are still here.",
      );
    });
    expect(mocks.patchSession).not.toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ agentBuilderOpen: false }),
    );
    expect(screen.getByTestId("agent-builder-rail")).toBeVisible();
    consoleError.mockRestore();
  });

  it("tracks local edit state for the builder session", () => {
    render(
      <ChatRightRail
        contextVisible={mocks.rightRailOpen}
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
        contextVisible={mocks.rightRailOpen}
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
