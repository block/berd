import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import type { Message } from "@/shared/types/messages";
import {
  homeWidgetsToLayoutItems,
  layoutItemsToHomeWidgets,
} from "../lib/homeLayoutMapper";
import type { WidgetInstance, WidgetMutationHandlers } from "../widgets/types";
import { HOME_WIDGET_NODE_ATTR, WidgetCanvas } from "./WidgetCanvas";

const mocks = vi.hoisted(() => ({
  transcriptMounts: 0,
  transcriptUnmounts: 0,
  composerMounts: 0,
  composerUnmounts: 0,
  retainedTranscripts: [] as string[],
  camera: { centerX: 0, centerY: 0, zoomBps: 10_000 },
  constraints: {
    minCenter: -10_000,
    maxCenter: 10_000,
    minSize: 1,
    maxSize: 10_000,
    minZoomBps: 1_000,
    maxZoomBps: 20_000,
    maxTitleOverrideLength: 120,
    maxItems: 100,
  },
  saveCamera: vi.fn(),
}));

const messages: Message[] = [
  {
    id: "user-1",
    role: "user",
    created: Date.UTC(2026, 7, 20, 12, 0, 0),
    content: [{ type: "text", text: "Keep this transcript mounted" }],
    metadata: { userVisible: true },
  },
];

vi.mock("@/features/experiments/experimentPreferences", () => ({
  useExperiment: () => ({ enabled: true }),
  subscribeToExperimentChanges: () => () => {},
}));

vi.mock("@/features/chat/hooks/useChatTranscriptReadModel", () => ({
  useChatTranscriptReadModel: () => ({
    messages,
    isLoadingHistory: false,
    selectedPersona: undefined,
    sessionArtifactCwd: undefined,
    runtime: { chatState: "idle", streamingMessageId: null },
  }),
}));

vi.mock("@/features/chat/stores/chatStore", () => {
  const state = {
    messagesBySession: {},
    queuedMessageBySession: {},
    loadingSessionIds: new Set<string>(),
    retainMountedTranscript: (sessionId: string) => {
      mocks.retainedTranscripts.push(sessionId);
      return () => undefined;
    },
  };
  const useChatStore = (selector: (value: typeof state) => unknown) =>
    selector(state);
  useChatStore.getState = () => ({
    ...state,
    markSessionRead: vi.fn(),
  });
  return { useChatStore };
});

vi.mock("@/features/chat/ui/ChatTranscriptSurface", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/features/chat/ui/ChatTranscriptSurface")
    >();
  return {
    ...actual,
    ChatTranscriptSurface: (
      props: ComponentProps<typeof actual.ChatTranscriptSurface>,
    ) => {
      useEffect(() => {
        mocks.transcriptMounts += 1;
        return () => {
          mocks.transcriptUnmounts += 1;
        };
      }, []);
      return <actual.ChatTranscriptSurface {...props} />;
    },
  };
});

vi.mock("@/features/chat/ui/VirtualMessageTimelineGate", () => ({
  VirtualMessageTimelineGate: ({
    showPlaceholder,
    placeholder,
    footer,
  }: {
    showPlaceholder: boolean;
    placeholder: ReactNode;
    footer?: ReactNode;
  }) => (
    <>
      {showPlaceholder ? (
        <div data-testid="transcript-placeholder">{placeholder}</div>
      ) : (
        <div data-testid="hydrated-transcript">Hydrated transcript</div>
      )}
      {footer}
    </>
  ),
}));

vi.mock("@/features/chat/hooks/ArtifactPolicyContext", () => ({
  ArtifactPolicyProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/features/chat/capabilities/ConversationComposerCapability", () => ({
  useConversationComposerBinding: () => ({ binding: true }),
  ConversationComposerCapability: () => {
    useEffect(() => {
      mocks.composerMounts += 1;
      return () => {
        mocks.composerUnmounts += 1;
      };
    }, []);
    return <textarea data-testid="canvas-card-composer" aria-label="Message" />;
  },
}));

vi.mock("@/features/projects/stores/projectStore", () => ({
  useProjectStore: (selector: (state: { projects: never[] }) => unknown) =>
    selector({ projects: [] }),
}));

vi.mock("@/shared/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/i18n")>();
  return {
    ...actual,
    useLocaleFormatting: () => ({ formatRelativeTimeToNow: () => "just now" }),
  };
});

vi.mock("../stores/homeWidgetStore", () => ({
  useHomeWidgetStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      camera: mocks.camera,
      constraints: mocks.constraints,
      saveCamera: mocks.saveCamera,
    }),
}));

vi.mock("@/shared/profile/capabilities", () => ({
  useProfileCapability: () => true,
}));

function expandedChat(): WidgetInstance {
  return {
    id: "expanded-chat",
    type: "chatPin",
    x: 20,
    y: 20,
    z: 1,
    width: 480,
    height: 560,
    state: { sessionId: "canvas-session", presentation: "expanded" },
  };
}

function CanvasHarness() {
  const [instances, setInstances] = useState([expandedChat()]);
  const mutatePosition = (id: string, x: number, y: number) => {
    setInstances((current) => {
      const moved = current.map((instance) =>
        instance.id === id ? { ...instance, x, y } : instance,
      );
      // Exercise the same persistence serialization adopted after a confirmed save.
      return layoutItemsToHomeWidgets(homeWidgetsToLayoutItems(moved));
    });
  };
  const mutations: WidgetMutationHandlers = {
    addWidget: vi.fn(),
    moveWidget: (id, x, y) => mutatePosition(id, x, y),
    resizeWidget: vi.fn(),
    bumpZ: vi.fn(),
    removeWidget: vi.fn(),
    updateWidgetState: vi.fn(),
  };
  return <WidgetCanvas instances={instances} mutations={mutations} />;
}

function TestProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

describe("expanded chat canvas drag lifecycle", () => {
  beforeEach(() => {
    mocks.transcriptMounts = 0;
    mocks.transcriptUnmounts = 0;
    mocks.composerMounts = 0;
    mocks.composerUnmounts = 0;
    mocks.retainedTranscripts = [];
    useChatSessionStore.setState({
      sessions: [
        {
          id: "canvas-session",
          title: "Canvas session",
          createdAt: "2026-08-20T00:00:00.000Z",
          updatedAt: "2026-08-20T00:00:00.000Z",
          messageCount: 1,
        },
      ],
      activeSessionId: null,
      isLoading: false,
      isLoadingMoreSessions: false,
      hasHydratedSessions: true,
      sessionPageCursor: null,
      hasMoreSessions: false,
      isRightRailOpen: false,
      activeWorkspaceBySession: {},
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      toJSON: () => ({}),
    });
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
  });

  it("keeps transcript, composer, hydration, and availability ownership stable through drag movement and persistence", async () => {
    const user = userEvent.setup();
    const { container } = render(<CanvasHarness />, { wrapper: TestProviders });

    await waitFor(() =>
      expect(screen.getByTestId("hydrated-transcript")).toBeInTheDocument(),
    );
    const transcript = screen.getByTestId("hydrated-transcript");
    const composer = screen.getByTestId("canvas-card-composer");
    const activationRegion = container.querySelector(
      "[data-canvas-chat-activation='transcript']",
    ) as HTMLElement;
    fireEvent.click(activationRegion);
    expect(
      screen.getByRole("region", { name: "Canvas session" }),
    ).toHaveAttribute("data-canvas-chat-focused", "true");

    const widgetNode = container.querySelector(
      `[${HOME_WIDGET_NODE_ATTR}]`,
    ) as HTMLElement;
    const canvas = container.querySelector(
      "[data-home-widget-canvas]",
    ) as HTMLElement;

    await user.pointer([
      {
        keys: "[MouseLeft>]",
        target: widgetNode,
        coords: { clientX: 30, clientY: 30 },
      },
      {
        target: canvas,
        coords: { clientX: 1_030, clientY: 30 },
      },
    ]);
    // Cross fully outside the viewport, then return before ending the drag.
    expect(
      screen.getByRole("region", { name: "Canvas session" }),
    ).toHaveAttribute("data-canvas-chat-focused", "true");
    await user.pointer([
      { target: canvas, coords: { clientX: 60, clientY: 60 } },
      {
        keys: "[/MouseLeft]",
        target: canvas,
        coords: { clientX: 60, clientY: 60 },
      },
    ]);

    await act(async () => undefined);
    expect(screen.getByTestId("hydrated-transcript")).toBe(transcript);
    expect(screen.getByTestId("canvas-card-composer")).toBe(composer);
    expect(screen.queryByTestId("transcript-placeholder")).toBeNull();
    expect(mocks.transcriptMounts).toBe(1);
    expect(mocks.transcriptUnmounts).toBe(0);
    expect(mocks.composerMounts).toBe(1);
    expect(mocks.composerUnmounts).toBe(0);
    expect(mocks.retainedTranscripts).toEqual(["canvas-session"]);
    expect(
      screen.getByRole("region", { name: "Canvas session" }),
    ).toHaveAttribute("data-canvas-chat-focused", "true");
  });
});
