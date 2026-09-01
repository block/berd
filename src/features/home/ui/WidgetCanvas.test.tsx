import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LayoutCamera,
  LayoutConstraints,
} from "@/features/layout/api/layout";
import type {
  WidgetInstance,
  WidgetMutationHandlers,
  WidgetNavigationHandlers,
} from "../widgets/types";
import { HOME_WIDGET_NODE_ATTR, WidgetCanvas } from "./WidgetCanvas";
import {
  isStarterHomeLayoutEligible,
  markStarterHomeLayoutEligible,
} from "@/features/home/onboarding/starterHomeLayout";
import {
  consumeFreshWidgetPlacement,
  markFreshWidgetPlacement,
} from "../lib/freshWidgetPlacements";

const HOME_WIDGET_NODE_SELECTOR = `[${HOME_WIDGET_NODE_ATTR}]`;

const mocks = vi.hoisted(() => ({
  saveCamera: vi.fn(),
  getAutomationTiles: vi.fn(),
  getAutomationTile: vi.fn(),
  loadMoreSessions: vi.fn(),
  hasMoreSessions: false,
  isLoadingMoreSessions: false,
  homeWidgetState: {
    camera: { centerX: 0, centerY: 0, zoomBps: 10_000 } as LayoutCamera,
    constraints: null as LayoutConstraints | null,
  },
  profileCapabilities: {
    automations: true,
  },
  personas: [
    {
      id: "agent-1",
      displayName: "Agent One",
      isBuiltin: false,
    },
    {
      id: "agent-2",
      displayName: "Agent Two",
      isBuiltin: false,
    },
  ],
  sessions: [
    {
      id: "session-1",
      title: "First chat",
      projectId: "project-1",
      createdAt: "2026-05-19T12:00:00.000Z",
      updatedAt: "2026-05-20T12:00:00.000Z",
      messageCount: 2,
    },
    {
      id: "session-empty",
      title: "Empty chat",
      createdAt: "2026-05-19T12:00:00.000Z",
      updatedAt: "2026-05-20T12:00:00.000Z",
      messageCount: 0,
    },
    {
      id: "session-blank-title",
      title: "   ",
      createdAt: "2026-05-19T12:00:00.000Z",
      updatedAt: "2026-05-20T12:00:00.000Z",
      messageCount: 1,
    },
    {
      id: "session-archived",
      title: "Archived chat",
      createdAt: "2026-05-19T12:00:00.000Z",
      updatedAt: "2026-05-20T12:00:00.000Z",
      archivedAt: "2026-05-20T13:00:00.000Z",
      messageCount: 3,
    },
  ],
  messagesBySession: {},
  projects: [
    {
      id: "project-1",
      name: "Alpha Project",
      description: "Alpha description",
      prompt: "Plan Alpha",
      icon: "tabler:code",
      color: "olive",
      workingDirs: ["/tmp/alpha"],
    },
    {
      id: "project-2",
      name: "Beta Project",
      description: "Beta description",
      prompt: "Plan Beta",
      icon: "tabler:rocket",
      color: "pink",
      workingDirs: ["/tmp/beta"],
    },
  ],
}));

vi.mock("../stores/homeWidgetStore", () => ({
  useHomeWidgetStore: (selector: (state: unknown) => unknown) =>
    selector({ ...mocks.homeWidgetState, saveCamera: mocks.saveCamera }),
}));

vi.mock("@/features/agents/stores/agentStore", () => ({
  useAgentStore: (selector: (state: unknown) => unknown) =>
    selector({
      personas: mocks.personas,
    }),
}));

vi.mock("@/features/chat/stores/chatSessionStore", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/features/chat/stores/chatSessionStore")
    >();
  return {
    ...actual,
    useChatSessionStore: (selector: (state: unknown) => unknown) =>
      selector({
        sessions: mocks.sessions,
        hasMoreSessions: mocks.hasMoreSessions,
        isLoadingMoreSessions: mocks.isLoadingMoreSessions,
        loadMoreSessions: mocks.loadMoreSessions,
      }),
  };
});

vi.mock("@/features/chat/stores/chatStore", () => ({
  useChatStore: (selector: (state: unknown) => unknown) =>
    selector({ messagesBySession: mocks.messagesBySession }),
}));

vi.mock("@/features/experiments/experimentPreferences", () => ({
  useExperiment: () => ({ enabled: true }),
  subscribeToExperimentChanges: () => () => {},
}));

vi.mock("../widgets/ChatCanvasCard", () => ({
  ChatCanvasCard: ({
    session,
    isFocused,
    onFocus,
    shouldIgnoreActivation = () => false,
  }: {
    session: { title: string };
    isFocused: boolean;
    onFocus?: () => void;
    shouldIgnoreActivation?: () => boolean;
  }) => (
    <div data-focused={String(isFocused)}>
      <div data-home-widget-drag-handle="true" />
      <button
        type="button"
        data-focused={String(isFocused)}
        onClick={() => {
          if (!shouldIgnoreActivation()) onFocus?.();
        }}
      >
        Focus {session.title}
      </button>
      <div
        data-testid={`transcript-${session.title}`}
        data-home-canvas-interactive="true"
        className="overflow-y-auto"
      />
      <textarea
        data-testid={`composer-${session.title}`}
        data-home-canvas-interactive="true"
        aria-label={`Compose in ${session.title}`}
      />
    </div>
  ),
}));

vi.mock("@/features/automations/api/kgooseAutomations", () => ({
  getAutomationTiles: mocks.getAutomationTiles,
  getAutomationTile: mocks.getAutomationTile,
}));

vi.mock("@/shared/profile/capabilities", () => ({
  useProfileCapability: (id: keyof typeof mocks.profileCapabilities) =>
    mocks.profileCapabilities[id] ?? true,
}));

vi.mock("@/features/projects/stores/projectStore", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) =>
    selector({ projects: mocks.projects }),
}));

vi.mock("@/features/projects/artifact/ProjectArtifactPreview", () => ({
  ProjectArtifactPreview: ({
    input,
    renderPaused,
  }: {
    input: { name: string };
    renderPaused?: boolean;
  }) => (
    <div
      data-testid="project-artifact-preview"
      data-render-paused={String(renderPaused ?? false)}
    >
      {input.name}
    </div>
  ),
}));

const CANVAS_CONSTRAINTS: LayoutConstraints = {
  minCenter: -1000,
  maxCenter: 1000,
  minSize: 1,
  maxSize: 10_000,
  minZoomBps: 1000,
  maxZoomBps: 20_000,
  maxTitleOverrideLength: 120,
  maxItems: 100,
};

function canvasRect({
  left = 0,
  top = 0,
  width = 800,
  height = 600,
}: Partial<Pick<DOMRect, "left" | "top" | "width" | "height">> = {}): DOMRect {
  return {
    width,
    height,
    left,
    top,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

function mutationHandlers(
  overrides: Partial<WidgetMutationHandlers> = {},
): WidgetMutationHandlers {
  return {
    addWidget: vi.fn(),
    moveWidget: vi.fn(),
    resizeWidget: vi.fn(),
    bumpZ: vi.fn(),
    removeWidget: vi.fn(),
    updateWidgetState: vi.fn(),
    ...overrides,
  };
}

function widget(overrides: Partial<WidgetInstance> = {}): WidgetInstance {
  return {
    id: "clock-widget",
    type: "clock",
    x: 20,
    y: 30,
    z: 1,
    ...overrides,
  };
}

function agentWidget(): WidgetInstance {
  return widget({
    id: "agent-widget",
    type: "agentPin",
    state: { agentId: "agent-1" },
  });
}

function chatWidget(overrides: Partial<WidgetInstance> = {}): WidgetInstance {
  return widget({
    id: "chat-widget",
    type: "chatPin",
    state: { sessionId: "session-blank-title" },
    ...overrides,
  });
}

function stickyNoteWidget(
  overrides: Partial<WidgetInstance> = {},
): WidgetInstance {
  return widget({
    id: "sticky-note-widget",
    type: "stickyNote",
    x: -320,
    y: -250,
    width: 224,
    height: 196,
    state: { noteId: "onboarding:build-agent" },
    ...overrides,
  });
}

type RenderCanvasOptions = WidgetNavigationHandlers & {
  instances?: WidgetInstance[];
  mutations?: Partial<WidgetMutationHandlers>;
  animateCameraTransition?: boolean;
  onRecenter?: () => void;
  recenterTarget?: { x: number; y: number } | null;
  recenterLabel?: string;
  recenterTitle?: string;
  viewportLeftOcclusionPx?: number;
  onCreatePersona?: () => void;
  onCreateProject?: () => void;
  starterTasksAvailable?: boolean;
  onRestoreStarterTasks?: () => void;
};

function PickerTestProvider({ children }: { children: ReactNode }) {
  // Fresh QueryClient per render so cached skill queries don't leak between
  // tests. The picker only triggers a skill fetch when its skill panel opens.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function renderCanvas({
  instances = [],
  mutations = {},
  animateCameraTransition,
  ...navigation
}: RenderCanvasOptions = {}) {
  return render(
    <PickerTestProvider>
      <WidgetCanvas
        instances={instances}
        mutations={mutationHandlers(mutations)}
        animateCameraTransition={animateCameraTransition}
        {...navigation}
      />
    </PickerTestProvider>,
  );
}

function widgetWorld(container: HTMLElement): HTMLElement {
  return container.firstElementChild?.firstElementChild as HTMLElement;
}

function setDevicePixelRatio(value: number) {
  Object.defineProperty(window, "devicePixelRatio", {
    configurable: true,
    value,
  });
}

const PANEL_LABELS = {
  widgets: /^widgets$/i,
  agent: /^agent$/i,
  chat: /^chat$/i,
  project: /^project$/i,
  skill: /^skill$/i,
  automation: /^automations$/i,
} as const;

async function openPickerPanel(
  user: ReturnType<typeof userEvent.setup>,
  container: HTMLElement,
  panel: keyof typeof PANEL_LABELS,
) {
  fireEvent.contextMenu(container.firstElementChild as Element, {
    clientX: 100,
    clientY: 120,
  });
  await user.click(screen.getByRole("button", { name: PANEL_LABELS[panel] }));
}

describe("WidgetCanvas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.useRealTimers();
    mocks.homeWidgetState.camera = { centerX: 0, centerY: 0, zoomBps: 10_000 };
    mocks.homeWidgetState.constraints = null;
    mocks.profileCapabilities.automations = true;
    mocks.hasMoreSessions = false;
    mocks.isLoadingMoreSessions = false;
    mocks.loadMoreSessions.mockResolvedValue(undefined);
    mocks.getAutomationTiles.mockResolvedValue({
      tiles: [
        {
          id: "automation-1",
          title: "Daily PR Summary",
        },
        {
          id: "automation-2",
          title: "Weekly Design Review",
        },
      ],
    });
    mocks.getAutomationTile.mockResolvedValue({});
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setDevicePixelRatio(1);
  });

  it("settles a freshly placed expanded chat like every other widget", () => {
    const chat = chatWidget({
      id: "fresh-expanded-chat",
      state: { sessionId: "session-1", presentation: "expanded" },
    });
    markFreshWidgetPlacement(chat.id);

    const { container } = renderCanvas({ instances: [chat] });
    const frame = container.querySelector(
      `[data-home-widget-id="${chat.id}"] fieldset`,
    );

    expect(frame).toHaveClass("animate-widget-settle");
    consumeFreshWidgetPlacement(chat.id);
  });

  it("renders composers for multiple expanded chats independently of focus", () => {
    const first = chatWidget({
      id: "first-chat",
      state: { sessionId: "session-1", presentation: "expanded" },
    });
    const second = chatWidget({
      id: "second-chat",
      state: { sessionId: "session-blank-title", presentation: "expanded" },
    });

    renderCanvas({ instances: [first, second] });

    expect(screen.getAllByRole("textbox")).toHaveLength(2);
    expect(screen.getByTestId("composer-First chat")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Focus First chat" }),
    ).toHaveAttribute("data-focused", "false");
    expect(screen.getByRole("button", { name: /Focus\s*$/ })).toHaveAttribute(
      "data-focused",
      "false",
    );
  });

  it("gives sole ephemeral focus to the deliberately clicked expanded chat", async () => {
    const user = userEvent.setup();
    const first = chatWidget({
      id: "first-chat",
      state: { sessionId: "session-1", presentation: "expanded" },
    });
    const second = chatWidget({
      id: "second-chat",
      state: { sessionId: "session-blank-title", presentation: "expanded" },
    });
    const { rerender } = renderCanvas({ instances: [first, second] });

    const firstCard = screen.getByRole("button", { name: "Focus First chat" });
    const secondCard = screen.getByRole("button", { name: /Focus\s*$/ });
    expect(firstCard).toHaveAttribute("data-focused", "false");
    expect(secondCard).toHaveAttribute("data-focused", "false");

    await user.click(firstCard);
    expect(firstCard).toHaveAttribute("data-focused", "true");
    expect(secondCard).toHaveAttribute("data-focused", "false");

    await user.click(secondCard);
    expect(firstCard).toHaveAttribute("data-focused", "false");
    expect(secondCard).toHaveAttribute("data-focused", "true");

    rerender(
      <PickerTestProvider>
        <WidgetCanvas instances={[first]} mutations={mutationHandlers()} />
      </PickerTestProvider>,
    );
    expect(firstCard).toHaveAttribute("data-focused", "false");
  });

  it("clears chat focus when the canvas background or another widget takes ownership", async () => {
    const user = userEvent.setup();
    const chat = chatWidget({
      state: { sessionId: "session-1", presentation: "expanded" },
    });
    const { container } = renderCanvas({ instances: [chat, agentWidget()] });
    const chatCard = screen.getByRole("button", { name: "Focus First chat" });

    await user.click(chatCard);
    expect(chatCard).toHaveAttribute("data-focused", "true");

    await user.pointer({
      keys: "[MouseLeft]",
      target: container.firstElementChild as Element,
      coords: { clientX: 700, clientY: 500 },
    });
    expect(chatCard).toHaveAttribute("data-focused", "false");

    await user.click(chatCard);
    fireEvent.pointerDown(screen.getByRole("button", { name: /agent one/i }), {
      button: 0,
      pointerId: 2,
    });
    await waitFor(() =>
      expect(chatCard).toHaveAttribute("data-focused", "false"),
    );
  });

  it("requires fresh activation after a focused card is temporarily unavailable and remounts", async () => {
    const user = userEvent.setup();
    const chat = chatWidget({
      state: { sessionId: "session-1", presentation: "expanded" },
    });
    const { rerender } = renderCanvas({ instances: [chat] });
    const card = screen.getByRole("button", { name: "Focus First chat" });

    await user.click(card);
    expect(card).toHaveAttribute("data-focused", "true");

    const temporarilyUnavailable = {
      ...chat,
      state: { ...chat.state, presentation: "collapsed" },
    };
    rerender(
      <PickerTestProvider>
        <WidgetCanvas
          instances={[temporarilyUnavailable]}
          mutations={mutationHandlers()}
        />
      </PickerTestProvider>,
    );
    expect(
      screen.queryByRole("button", { name: "Focus First chat" }),
    ).toBeNull();

    rerender(
      <PickerTestProvider>
        <WidgetCanvas instances={[chat]} mutations={mutationHandlers()} />
      </PickerTestProvider>,
    );
    const remountedCard = screen.getByRole("button", {
      name: "Focus First chat",
    });
    await waitFor(() =>
      expect(remountedCard).toHaveAttribute("data-focused", "false"),
    );

    await user.click(remountedCard);
    expect(remountedCard).toHaveAttribute("data-focused", "true");
  });

  it("renders widgets directly at snapped screen positions", () => {
    mocks.homeWidgetState.camera = {
      centerX: -10.25,
      centerY: -20.25,
      zoomBps: 10_000,
    };
    setDevicePixelRatio(2);

    const { container } = renderCanvas({ instances: [widget()] });
    const world = widgetWorld(container);
    const widgetNode = container.querySelector(
      HOME_WIDGET_NODE_SELECTOR,
    ) as HTMLElement;

    expect(world.style.transform).toBe("");
    expect(widgetNode.style.transform).toBe("");
    expect(widgetNode.style.zoom).toBeUndefined();
    expect(widgetNode.style.left).toBe("30.5px");
    expect(widgetNode.style.top).toBe("50.5px");
  });

  it("updates snapped widget placement when device pixel ratio changes", () => {
    mocks.homeWidgetState.camera = {
      centerX: -10.25,
      centerY: -20.25,
      zoomBps: 10_000,
    };
    setDevicePixelRatio(1);

    const { container } = renderCanvas({ instances: [widget()] });
    const widgetNode = container.querySelector(
      HOME_WIDGET_NODE_SELECTOR,
    ) as HTMLElement;
    expect(widgetNode.style.left).toBe("30px");
    expect(widgetNode.style.top).toBe("50px");

    setDevicePixelRatio(2);
    fireEvent.resize(window);

    expect(widgetNode.style.left).toBe("30.5px");
    expect(widgetNode.style.top).toBe("50.5px");
  });

  it("zooms widget contents without scaling the positioned widget shell", () => {
    mocks.homeWidgetState.camera = {
      centerX: -10.25,
      centerY: -20.25,
      zoomBps: 12_500,
    };
    setDevicePixelRatio(2);

    const { container } = renderCanvas({
      instances: [widget({ x: 20.25, y: 30.25, width: 240, height: 240 })],
    });
    const world = widgetWorld(container);
    const widgetNode = container.querySelector(
      HOME_WIDGET_NODE_SELECTOR,
    ) as HTMLElement;
    const widgetContent = widgetNode.firstElementChild as HTMLElement;

    expect(world.style.transform).toBe("");
    expect(widgetNode.style.transform).toBe("");
    expect(widgetNode.style.zoom).toBeUndefined();
    expect(widgetNode.style.left).toBe("38px");
    expect(widgetNode.style.top).toBe("63px");
    expect(widgetNode.style.width).toBe("300px");
    expect(widgetNode.style.height).toBe("300px");
    expect(
      Number(widgetNode.style.getPropertyValue("--widget-text-scale")),
    ).toBeCloseTo((240 / 156) * 1.08);
    expect(widgetContent.style.transform).toBe("scale(1.25)");
    expect(widgetContent.style.transformOrigin).toBe("top left");
    expect(widgetContent.style.width).toBe("240px");
    expect(widgetContent.style.height).toBe("240px");
  });

  it.each([
    [5_000, "240px", "280px", "scale(0.5)"],
    [7_500, "360px", "420px", "scale(0.75)"],
  ])("uses the standard widget transform path for expanded chats at %i zoom bps", (zoomBps, expectedWidth, expectedHeight, expectedTransform) => {
    mocks.homeWidgetState.camera = { centerX: 0, centerY: 0, zoomBps };

    const { container } = renderCanvas({
      instances: [
        chatWidget({
          width: 480,
          height: 560,
          state: { sessionId: "session-1", presentation: "expanded" },
        }),
      ],
    });
    const widgetNode = container.querySelector(
      HOME_WIDGET_NODE_SELECTOR,
    ) as HTMLElement;
    const widgetContent = widgetNode.firstElementChild as HTMLElement;

    expect(widgetNode.style.width).toBe(expectedWidth);
    expect(widgetNode.style.height).toBe(expectedHeight);
    expect(
      widgetNode.style.getPropertyValue("--canvas-presentation-scale"),
    ).toBe("");
    expect(widgetContent.style.width).toBe("480px");
    expect(widgetContent.style.height).toBe("560px");
    expect(widgetContent.style.transform).toBe(expectedTransform);
    expect(widgetContent.style.transformOrigin).toBe("top left");
  });

  it("keeps expanded chat drag persistence in world coordinates", async () => {
    const user = userEvent.setup();
    const moveWidget = vi.fn();
    mocks.homeWidgetState.constraints = CANVAS_CONSTRAINTS;
    mocks.homeWidgetState.camera = {
      centerX: 0,
      centerY: 0,
      zoomBps: 7_500,
    };
    const chat = chatWidget({
      x: 20,
      y: 30,
      width: 480,
      height: 560,
      state: { sessionId: "session-1", presentation: "expanded" },
    });
    const { container } = renderCanvas({
      instances: [chat],
      mutations: { moveWidget },
    });
    const canvas = container.firstElementChild as Element;
    const widgetNode = container.querySelector(
      HOME_WIDGET_NODE_SELECTOR,
    ) as HTMLElement;
    const dragHandle = widgetNode.querySelector(
      "[data-home-widget-drag-handle='true']",
    ) as HTMLElement;

    await user.pointer([
      {
        keys: "[MouseLeft>]",
        target: dragHandle,
        coords: { clientX: 30, clientY: 40 },
      },
      { target: canvas, coords: { clientX: 60, clientY: 85 } },
      {
        keys: "[/MouseLeft]",
        target: canvas,
        coords: { clientX: 60, clientY: 85 },
      },
    ]);

    expect(moveWidget).toHaveBeenCalledWith(
      "chat-widget",
      60,
      90,
      CANVAS_CONSTRAINTS,
      { bringToFront: true },
    );
  });

  it("does not drag an expanded chat from its transcript", async () => {
    const user = userEvent.setup();
    const moveWidget = vi.fn();
    mocks.homeWidgetState.constraints = CANVAS_CONSTRAINTS;
    const chat = chatWidget({
      state: { sessionId: "session-1", presentation: "expanded" },
    });
    const { container } = renderCanvas({
      instances: [chat],
      mutations: { moveWidget },
    });
    const canvas = container.firstElementChild as Element;
    const transcript = screen.getByTestId("transcript-First chat");

    await user.pointer([
      {
        keys: "[MouseLeft>]",
        target: transcript,
        coords: { clientX: 30, clientY: 40 },
      },
      { target: canvas, coords: { clientX: 80, clientY: 100 } },
      {
        keys: "[/MouseLeft]",
        target: canvas,
        coords: { clientX: 80, clientY: 100 },
      },
    ]);

    expect(moveWidget).not.toHaveBeenCalled();
  });

  it("lays out non-aspect resize previews at preview dimensions so text is not stretched", async () => {
    const user = userEvent.setup();
    mocks.homeWidgetState.constraints = CANVAS_CONSTRAINTS;

    const { container } = renderCanvas({ instances: [chatWidget()] });
    const canvas = container.firstElementChild as Element;
    const resizeHandle = screen.getByRole("button", {
      name: /resize pin a chat/i,
    });

    await user.pointer([
      {
        keys: "[MouseLeft>]",
        target: resizeHandle,
        coords: { clientX: 208, clientY: 110 },
      },
      {
        target: canvas,
        coords: { clientX: 328, clientY: 150 },
      },
    ]);

    const widgetNode = container.querySelector(
      HOME_WIDGET_NODE_SELECTOR,
    ) as HTMLElement;
    const widgetContent = widgetNode.firstElementChild as HTMLElement;

    expect(widgetNode.style.width).toBe("308px");
    expect(widgetNode.style.height).toBe("120px");
    expect(widgetContent.style.width).toBe("308px");
    expect(widgetContent.style.height).toBe("120px");
    expect(widgetContent.style.transform).toBe("");
    expect(screen.getByText("New chat")).toHaveClass(
      "break-words",
      "line-clamp-2",
    );
  });

  it("does not transform non-aspect resize previews when width and height scale evenly", async () => {
    const user = userEvent.setup();
    mocks.homeWidgetState.constraints = CANVAS_CONSTRAINTS;

    const { container } = renderCanvas({ instances: [chatWidget()] });
    const canvas = container.firstElementChild as Element;
    const resizeHandle = screen.getByRole("button", {
      name: /resize pin a chat/i,
    });

    await user.pointer([
      {
        keys: "[MouseLeft>]",
        target: resizeHandle,
        coords: { clientX: 208, clientY: 110 },
      },
      {
        target: canvas,
        coords: { clientX: 302, clientY: 150 },
      },
    ]);

    const widgetNode = container.querySelector(
      HOME_WIDGET_NODE_SELECTOR,
    ) as HTMLElement;
    const widgetContent = widgetNode.firstElementChild as HTMLElement;

    expect(widgetNode.style.width).toBe("282px");
    expect(widgetNode.style.height).toBe("120px");
    expect(widgetContent.style.width).toBe("282px");
    expect(widgetContent.style.height).toBe("120px");
    expect(widgetContent.style.transform).toBe("");
  });

  it("adds a short position transition during recenter motion", () => {
    const { container, rerender } = renderCanvas({
      instances: [widget()],
      animateCameraTransition: false,
    });
    const widgetNode = container.querySelector(
      HOME_WIDGET_NODE_SELECTOR,
    ) as HTMLElement;
    expect(widgetNode.className).not.toContain("transition-[left,top]");

    rerender(
      <PickerTestProvider>
        <WidgetCanvas
          instances={[widget()]}
          mutations={mutationHandlers()}
          animateCameraTransition={true}
        />
      </PickerTestProvider>,
    );

    expect(widgetNode.className).toContain("transition-[left,top]");
  });

  it("shows a centered recenter button when all widgets are offscreen", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      canvasRect(),
    );

    renderCanvas({
      instances: [widget({ x: 2000, y: 30 })],
      onRecenter: vi.fn(),
      recenterTarget: { x: 2120, y: 150 },
      recenterLabel: "Recenter",
      recenterTitle: "Recenter pinned objects",
    });

    const recenterButton = screen.getByRole("button", { name: "Recenter" });
    expect(recenterButton).toBeVisible();
    expect(recenterButton).toHaveClass("pointer-events-auto");
    expect(recenterButton).toHaveClass("animate-scale-in");
    expect(recenterButton).not.toHaveAttribute("title");
  });

  it("animates the centered recenter button out before unmounting", () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      canvasRect(),
    );

    const onRecenter = vi.fn();
    const { rerender } = renderCanvas({
      instances: [widget({ x: 2000, y: 30 })],
      onRecenter,
      recenterTarget: { x: 2120, y: 150 },
      recenterLabel: "Recenter",
    });

    expect(screen.getByRole("button", { name: "Recenter" })).toHaveClass(
      "animate-scale-in",
    );

    rerender(
      <PickerTestProvider>
        <WidgetCanvas
          instances={[widget()]}
          mutations={mutationHandlers()}
          onRecenter={onRecenter}
          recenterTarget={{ x: 2120, y: 150 }}
          recenterLabel="Recenter"
        />
      </PickerTestProvider>,
    );

    expect(screen.queryByRole("button", { name: "Recenter" })).toBeNull();

    const exitingButton = screen.getByRole("button", {
      name: "Recenter",
      hidden: true,
    });
    expect(exitingButton).toHaveClass("opacity-0");
    expect(exitingButton).toHaveClass("scale-95");
    expect(exitingButton).toHaveClass("translate-y-1");
    expect(exitingButton).toHaveClass("pointer-events-none");
    expect(exitingButton).toHaveAttribute("tabindex", "-1");

    act(() => {
      vi.advanceTimersByTime(180);
    });

    expect(
      screen.queryByRole("button", { name: "Recenter", hidden: true }),
    ).toBeNull();
  });

  it("shows the centered recenter button when content is only slightly on screen", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      canvasRect(),
    );

    renderCanvas({
      instances: [widget({ x: 760, y: 30 })],
      onRecenter: vi.fn(),
      recenterTarget: { x: 880, y: 150 },
      recenterLabel: "Recenter",
    });

    expect(screen.getByRole("button", { name: "Recenter" })).toBeVisible();
  });

  it("shows the centered recenter button when content is hidden by the sidebar", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      canvasRect(),
    );

    renderCanvas({
      instances: [widget({ x: -340, y: 30 })],
      onRecenter: vi.fn(),
      recenterTarget: { x: -220, y: 150 },
      recenterLabel: "Recenter",
      viewportLeftOcclusionPx: 260,
    });

    const recenterButton = screen.getByRole("button", { name: "Recenter" });
    expect(recenterButton).toBeVisible();
    expect(recenterButton.parentElement).toHaveStyle({ left: "260px" });
  });

  it("hides the centered recenter button while any widget is visible", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      canvasRect(),
    );

    renderCanvas({
      instances: [widget(), widget({ id: "offscreen-widget", x: 2000 })],
      onRecenter: vi.fn(),
      recenterTarget: { x: 1120, y: 150 },
      recenterLabel: "Recenter",
    });

    expect(screen.queryByRole("button", { name: "Recenter" })).toBeNull();
  });

  it("hides the centered recenter button when the recenter target is in view", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      canvasRect(),
    );

    renderCanvas({
      instances: [widget({ x: -220 }), widget({ id: "right-edge", x: 780 })],
      onRecenter: vi.fn(),
      recenterTarget: { x: 400, y: 150 },
      recenterLabel: "Recenter",
    });

    expect(screen.queryByRole("button", { name: "Recenter" })).toBeNull();
  });

  it("does not show the centered recenter button for an empty canvas", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      canvasRect(),
    );

    renderCanvas({
      instances: [],
      onRecenter: vi.fn(),
      recenterLabel: "Recenter",
    });

    expect(screen.queryByRole("button", { name: "Recenter" })).toBeNull();
  });

  it("calls the recenter handler from the centered button", async () => {
    const user = userEvent.setup();
    const onRecenter = vi.fn();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      canvasRect(),
    );

    renderCanvas({
      instances: [widget({ x: 2000 })],
      onRecenter,
      recenterTarget: { x: 2120, y: 150 },
      recenterLabel: "Recenter",
    });

    await user.click(screen.getByRole("button", { name: "Recenter" }));

    expect(onRecenter).toHaveBeenCalledTimes(1);
  });

  it("renders sticky note widgets with actionable CTAs", async () => {
    const user = userEvent.setup();
    const onCreatePersona = vi.fn();
    const onCreateProject = vi.fn();
    const onOpenSkills = vi.fn();
    const onOpenAutomations = vi.fn();
    const removeWidget = vi.fn();

    renderCanvas({
      instances: [
        stickyNoteWidget({
          id: "welcome-sticky-note-widget",
          state: { noteId: "onboarding:welcome" },
        }),
        stickyNoteWidget(),
        stickyNoteWidget({
          id: "project-sticky-note-widget",
          state: { noteId: "onboarding:start-project" },
        }),
        stickyNoteWidget({
          id: "workflow-sticky-note-widget",
          state: { noteId: "onboarding:reuse-workflows" },
        }),
        stickyNoteWidget({
          id: "home-sticky-note-widget",
          state: { noteId: "onboarding:shape-home" },
        }),
        stickyNoteWidget({
          id: "automations-sticky-note-widget",
          state: { noteId: "onboarding:manage-automations" },
        }),
      ],
      mutations: { removeWidget },
      onCreatePersona,
      onCreateProject,
      onOpenSkills,
      onOpenAutomations,
    });

    expect(screen.getByText("Welcome to Berd")).toBeInTheDocument();
    expect(screen.getByText("Build an agent")).toBeInTheDocument();
    expect(screen.getByText("Start a project")).toBeInTheDocument();
    expect(screen.getByText("Teach Berd a skill")).toBeInTheDocument();
    expect(screen.getByText("Make Home yours")).toBeInTheDocument();
    expect(screen.getByText("Manage automations")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /build agent/i }));
    await user.click(screen.getByRole("button", { name: /new project/i }));
    await user.click(screen.getByRole("button", { name: /explore skills/i }));
    await user.click(screen.getByRole("button", { name: /open automations/i }));
    await user.click(
      screen.getAllByRole("button", { name: /dismiss sticky note/i })[0],
    );

    expect(onCreatePersona).toHaveBeenCalledTimes(1);
    expect(onCreateProject).toHaveBeenCalledTimes(1);
    expect(onOpenSkills).toHaveBeenCalledTimes(1);
    expect(onOpenAutomations).toHaveBeenCalledTimes(1);
    expect(removeWidget).toHaveBeenCalledWith("welcome-sticky-note-widget");
    expect(screen.queryByRole("button", { name: /make home/i })).toBeNull();
  });

  it("cancels pending starter arrangement when a user drags a widget", async () => {
    const user = userEvent.setup();
    markStarterHomeLayoutEligible();

    const { container } = renderCanvas({ instances: [stickyNoteWidget()] });
    const canvas = container.firstElementChild as Element;
    const stickyNode = container.querySelector(HOME_WIDGET_NODE_SELECTOR);

    await user.pointer([
      {
        keys: "[MouseLeft>]",
        target: stickyNode as Element,
        coords: { clientX: 24, clientY: 34 },
      },
      { target: canvas, coords: { clientX: 54, clientY: 82 } },
      {
        keys: "[/MouseLeft]",
        target: canvas,
        coords: { clientX: 54, clientY: 82 },
      },
    ]);

    expect(isStarterHomeLayoutEligible()).toBe(false);
  });

  it("drags sticky note widgets through the same widget frame pipeline", async () => {
    const user = userEvent.setup();
    const moveWidget = vi.fn();
    mocks.homeWidgetState.constraints = CANVAS_CONSTRAINTS;

    const { container } = renderCanvas({
      instances: [stickyNoteWidget()],
      mutations: { moveWidget },
    });

    const canvas = container.firstElementChild as Element;
    const stickyNode = container.querySelector(HOME_WIDGET_NODE_SELECTOR);
    expect(stickyNode).not.toBeNull();

    await user.pointer([
      {
        keys: "[MouseLeft>]",
        target: stickyNode as Element,
        coords: { clientX: 24, clientY: 34 },
      },
      {
        target: canvas,
        coords: { clientX: 54, clientY: 82 },
      },
      {
        keys: "[/MouseLeft]",
        target: canvas,
        coords: { clientX: 54, clientY: 82 },
      },
    ]);

    expect(moveWidget).toHaveBeenCalledWith(
      "sticky-note-widget",
      -290,
      -202,
      CANVAS_CONSTRAINTS,
      { bringToFront: true },
    );
  });

  it("allows child widget clicks when the pointer does not drag", () => {
    const onOpenAgent = vi.fn();
    const bumpZ = vi.fn();
    const moveWidget = vi.fn();

    renderCanvas({
      instances: [agentWidget(), widget({ x: 300, z: 2 })],
      mutations: { bumpZ, moveWidget },
      onOpenAgent,
    });

    const agentButton = screen.getByRole("button", { name: /agent one/i });
    fireEvent.pointerDown(agentButton, {
      button: 0,
      pointerId: 1,
      clientX: 24,
      clientY: 34,
    });
    fireEvent.pointerUp(agentButton, {
      button: 0,
      pointerId: 1,
      clientX: 24,
      clientY: 34,
    });
    fireEvent.click(agentButton);

    expect(onOpenAgent).toHaveBeenCalledWith("agent-1");
    expect(bumpZ).toHaveBeenCalledWith("agent-widget");
    expect(moveWidget).not.toHaveBeenCalled();
    expect(HTMLElement.prototype.setPointerCapture).not.toHaveBeenCalled();
  });

  it("uses a default title for pinned chats with blank session titles", () => {
    renderCanvas({
      instances: [chatWidget()],
    });

    expect(screen.getByRole("button", { name: /new chat/i })).toBeVisible();
    expect(screen.queryByText("Chat")).toBeNull();
  });

  it("ignores non-primary widget pointer gestures", () => {
    const moveWidget = vi.fn();

    renderCanvas({
      instances: [agentWidget()],
      mutations: { moveWidget },
    });

    const agentButton = screen.getByRole("button", { name: /agent one/i });
    const agentNode = agentButton.closest(HOME_WIDGET_NODE_SELECTOR);
    expect(agentNode).not.toBeNull();
    fireEvent.pointerDown(agentNode as Element, {
      button: 2,
      pointerId: 1,
      clientX: 24,
      clientY: 34,
    });
    fireEvent.pointerMove(agentNode as Element, {
      button: 2,
      pointerId: 1,
      clientX: 40,
      clientY: 34,
    });
    fireEvent.pointerUp(agentNode as Element, {
      button: 2,
      pointerId: 1,
      clientX: 40,
      clientY: 34,
    });

    expect(moveWidget).not.toHaveBeenCalled();
    expect(HTMLElement.prototype.setPointerCapture).not.toHaveBeenCalled();
  });

  it("prevents native browser drags inside the widget canvas", () => {
    const { container } = renderCanvas({
      instances: [widget()],
    });

    const clockNode = container.querySelector(HOME_WIDGET_NODE_SELECTOR);
    expect(clockNode).not.toBeNull();

    const dragStart = createEvent.dragStart(clockNode as Element, {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(clockNode as Element, dragStart);

    expect(dragStart.defaultPrevented).toBe(true);
    expect((clockNode as HTMLElement).draggable).toBe(false);
  });

  it("moves dragged widgets to the front with a single mutation", async () => {
    const user = userEvent.setup();
    const bumpZ = vi.fn();
    const moveWidget = vi.fn();
    mocks.homeWidgetState.constraints = CANVAS_CONSTRAINTS;

    const { container } = renderCanvas({
      instances: [widget(), widget({ id: "front-widget", x: 300, z: 2 })],
      mutations: { bumpZ, moveWidget },
    });

    const canvas = container.firstElementChild as Element;
    const clockNode = container.querySelector(HOME_WIDGET_NODE_SELECTOR);
    expect(clockNode).not.toBeNull();

    await user.pointer([
      {
        keys: "[MouseLeft>]",
        target: clockNode as Element,
        coords: { clientX: 24, clientY: 34 },
      },
      {
        target: canvas,
        coords: { clientX: 54, clientY: 82 },
      },
      {
        keys: "[/MouseLeft]",
        target: canvas,
        coords: { clientX: 54, clientY: 82 },
      },
    ]);

    expect(bumpZ).not.toHaveBeenCalled();
    expect(moveWidget).toHaveBeenCalledTimes(1);
    expect(moveWidget).toHaveBeenCalledWith(
      "clock-widget",
      50,
      78,
      CANVAS_CONSTRAINTS,
      { bringToFront: true },
    );
  });

  it("resizes widgets with type-specific bounds", async () => {
    const user = userEvent.setup();
    const resizeWidget = vi.fn();
    mocks.homeWidgetState.constraints = CANVAS_CONSTRAINTS;

    const { container } = renderCanvas({
      instances: [widget({ width: 240, height: 240 })],
      mutations: { resizeWidget },
    });

    const canvas = container.firstElementChild as Element;
    const resizeHandle = screen.getByRole("button", {
      name: /resize clock/i,
    });

    expect(resizeHandle).toHaveClass("hidden", "group-hover/widget:flex");
    expect(resizeHandle).not.toHaveClass(
      "opacity-0",
      "group-hover/widget:opacity-100",
    );

    await user.pointer([
      {
        keys: "[MouseLeft>]",
        target: resizeHandle,
        coords: { clientX: 260, clientY: 270 },
      },
      {
        target: canvas,
        coords: { clientX: 380, clientY: 390 },
      },
      {
        keys: "[/MouseLeft]",
        target: canvas,
        coords: { clientX: 380, clientY: 390 },
      },
    ]);

    expect(resizeWidget).toHaveBeenCalledWith(
      "clock-widget",
      360,
      360,
      CANVAS_CONSTRAINTS,
      { bringToFront: true },
    );
  });

  it("does not show a resize handle for labels", () => {
    renderCanvas({
      instances: [
        widget({
          id: "label-widget",
          type: "label",
          width: 280,
          height: 56,
          state: { text: "Weekly automations" },
        }),
      ],
    });

    expect(
      screen.queryByRole("button", { name: /resize label/i }),
    ).not.toBeInTheDocument();
  });

  it("shows a resize handle for the onboarding widget", () => {
    renderCanvas({
      instances: [
        widget({
          id: "onboarding-tour",
          type: "onboardingTour",
          state: { noteId: "onboarding:tour" },
        }),
      ],
    });

    expect(
      screen.getByRole("button", { name: /resize take a tour/i }),
    ).toBeInTheDocument();
  });

  it("clears temporary lift when resize ends without movement", async () => {
    const user = userEvent.setup();
    const resizeWidget = vi.fn();
    mocks.homeWidgetState.constraints = CANVAS_CONSTRAINTS;

    const { container } = renderCanvas({
      instances: [widget(), widget({ id: "front-widget", x: 300, z: 2 })],
      mutations: { resizeWidget },
    });

    const canvas = container.firstElementChild as Element;
    const clockNode = container.querySelector(
      HOME_WIDGET_NODE_SELECTOR,
    ) as HTMLElement | null;
    expect(clockNode).not.toBeNull();
    const resizeHandle = clockNode?.querySelector(
      'button[aria-label="Resize Clock"]',
    );
    expect(resizeHandle).not.toBeNull();

    await user.pointer([
      {
        keys: "[MouseLeft>]",
        target: resizeHandle as Element,
        coords: { clientX: 260, clientY: 270 },
      },
      {
        keys: "[/MouseLeft]",
        target: canvas,
        coords: { clientX: 260, clientY: 270 },
      },
    ]);

    expect(resizeWidget).not.toHaveBeenCalled();
    expect(clockNode?.style.zIndex).toBe("1");
  });

  it("keeps the widget picker open while panning the canvas background", async () => {
    const user = userEvent.setup();
    const { container } = renderCanvas();
    const canvas = container.firstElementChild as HTMLElement;

    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(canvasRect());
    fireEvent.contextMenu(canvas, { clientX: 100, clientY: 120 });
    expect(
      screen.getByRole("button", { name: PANEL_LABELS.widgets }),
    ).toBeInTheDocument();

    await user.pointer([
      {
        keys: "[MouseLeft>]",
        target: canvas,
        coords: { clientX: 200, clientY: 220 },
      },
      {
        target: canvas,
        coords: { clientX: 224, clientY: 196 },
      },
      {
        keys: "[/MouseLeft]",
        target: canvas,
        coords: { clientX: 224, clientY: 196 },
      },
    ]);

    expect(
      screen.getByRole("button", { name: PANEL_LABELS.widgets }),
    ).toBeInTheDocument();
  });

  it("closes the widget picker when empty canvas is clicked", async () => {
    const user = userEvent.setup();
    const { container } = renderCanvas();
    const canvas = container.firstElementChild as HTMLElement;

    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(canvasRect());
    fireEvent.contextMenu(canvas, { clientX: 100, clientY: 120 });
    expect(
      screen.getByRole("button", { name: PANEL_LABELS.widgets }),
    ).toBeInTheDocument();

    await user.click(canvas);

    expect(
      screen.queryByRole("button", { name: PANEL_LABELS.widgets }),
    ).not.toBeInTheDocument();
  });

  it("cancels pending starter arrangement when the user pans the canvas", async () => {
    const user = userEvent.setup();
    markStarterHomeLayoutEligible();
    const { container } = renderCanvas({ instances: [] });
    const canvas = container.firstElementChild as Element;

    await user.pointer({
      keys: "[MouseLeft>]",
      target: canvas,
      coords: { clientX: 100, clientY: 100 },
    });

    expect(isStarterHomeLayoutEligible()).toBe(false);
  });

  it("saves the camera after panning the canvas background", async () => {
    const user = userEvent.setup();
    const { container } = renderCanvas();
    const canvas = container.firstElementChild as HTMLElement;

    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(canvasRect());

    await user.pointer([
      {
        keys: "[MouseLeft>]",
        target: canvas,
        coords: { clientX: 100, clientY: 120 },
      },
      {
        target: canvas,
        coords: { clientX: 124, clientY: 96 },
      },
      {
        keys: "[/MouseLeft]",
        target: canvas,
        coords: { clientX: 124, clientY: 96 },
      },
    ]);

    expect(mocks.saveCamera).toHaveBeenCalledWith({
      centerX: expect.any(Number),
      centerY: expect.any(Number),
      zoomBps: 10_000,
    });
  });

  it("leaves interactive transcript and composer wheel gestures to the chat", () => {
    vi.useFakeTimers();
    const chat = chatWidget({
      state: { sessionId: "session-1", presentation: "expanded" },
    });
    const { container } = renderCanvas({ instances: [chat] });
    const canvas = container.firstElementChild as HTMLElement;
    const transcript = screen.getByTestId("transcript-First chat");
    const composer = screen.getByTestId("composer-First chat");

    expect(transcript).toHaveClass("overflow-y-auto");
    fireEvent.wheel(transcript, { deltaY: 30 });
    transcript.scrollTop = 30;
    fireEvent.scroll(transcript);
    fireEvent.wheel(composer, { deltaY: 30 });
    vi.advanceTimersByTime(150);

    expect(transcript.scrollTop).toBe(30);
    expect(mocks.saveCamera).not.toHaveBeenCalled();

    fireEvent.wheel(canvas, { deltaY: 30 });
    vi.advanceTimersByTime(150);
    expect(mocks.saveCamera).toHaveBeenCalledTimes(1);
  });

  it("saves the camera after two-finger wheel pan settles", () => {
    vi.useFakeTimers();
    const { container } = renderCanvas();
    const canvas = container.firstElementChild as HTMLElement;

    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(canvasRect());

    fireEvent.wheel(canvas, {
      clientX: 400,
      clientY: 300,
      deltaX: 16,
      deltaY: 40,
    });

    expect(mocks.saveCamera).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);

    expect(mocks.saveCamera).toHaveBeenCalledWith({
      centerX: expect.any(Number),
      centerY: expect.any(Number),
      zoomBps: 10_000,
    });
  });

  it("saves the camera after pinch-style wheel zoom settles", () => {
    vi.useFakeTimers();
    const { container } = renderCanvas();
    const canvas = container.firstElementChild as HTMLElement;

    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(canvasRect());

    fireEvent.wheel(canvas, {
      clientX: 400,
      clientY: 300,
      ctrlKey: true,
      deltaY: -120,
    });

    expect(mocks.saveCamera).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);

    expect(mocks.saveCamera).toHaveBeenCalledWith({
      centerX: expect.any(Number),
      centerY: expect.any(Number),
      zoomBps: expect.any(Number),
    });
    expect(mocks.saveCamera.mock.calls[0][0].zoomBps).toBeGreaterThan(10_000);
  });

  it("clamps broad backend zoom constraints to the home canvas max", () => {
    vi.useFakeTimers();
    mocks.homeWidgetState.constraints = {
      ...CANVAS_CONSTRAINTS,
      maxZoomBps: 80_000,
    };
    const { container } = renderCanvas();
    const canvas = container.firstElementChild as HTMLElement;

    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(canvasRect());

    fireEvent.wheel(canvas, {
      clientX: 400,
      clientY: 300,
      ctrlKey: true,
      deltaY: -10_000,
    });
    vi.advanceTimersByTime(150);

    expect(mocks.saveCamera).toHaveBeenCalledWith(
      expect.objectContaining({ zoomBps: 20_000 }),
    );
  });

  it("offers the Widgets > Clock path so users can repin the clock", async () => {
    const user = userEvent.setup();
    const addWidget = vi.fn();
    mocks.homeWidgetState.constraints = CANVAS_CONSTRAINTS;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      canvasRect({ left: 25, top: 50, width: 1000, height: 800 }),
    );

    const { container } = renderCanvas({ mutations: { addWidget } });

    await openPickerPanel(user, container, "widgets");
    await user.click(screen.getByRole("button", { name: /^clock$/i }));

    expect(addWidget).toHaveBeenCalledWith(
      "clock",
      expect.any(Number),
      expect.any(Number),
      undefined,
      CANVAS_CONSTRAINTS,
    );
  });

  it("offers the Widgets > Photo path for repeatable photo frames", async () => {
    const user = userEvent.setup();
    const addWidget = vi.fn();
    mocks.homeWidgetState.constraints = CANVAS_CONSTRAINTS;

    const { container } = renderCanvas({ mutations: { addWidget } });

    await openPickerPanel(user, container, "widgets");
    await user.click(screen.getByRole("button", { name: /^photo$/i }));

    expect(addWidget).toHaveBeenCalledWith(
      "photo",
      expect.any(Number),
      expect.any(Number),
      undefined,
      CANVAS_CONSTRAINTS,
    );
  });

  it("offers the Widgets > Sticky note path for repeatable user notes", async () => {
    const user = userEvent.setup();
    const addWidget = vi.fn();
    mocks.homeWidgetState.constraints = CANVAS_CONSTRAINTS;

    const { container } = renderCanvas({ mutations: { addWidget } });

    await openPickerPanel(user, container, "widgets");
    await user.click(screen.getByRole("button", { name: /^sticky note$/i }));

    expect(addWidget).toHaveBeenCalledWith(
      "stickyNote",
      expect.any(Number),
      expect.any(Number),
      undefined,
      CANVAS_CONSTRAINTS,
    );
  });

  it("offers the Widgets > Label path for canvas section labels", async () => {
    const user = userEvent.setup();
    const addWidget = vi.fn();
    mocks.homeWidgetState.constraints = CANVAS_CONSTRAINTS;

    const { container } = renderCanvas({ mutations: { addWidget } });

    await openPickerPanel(user, container, "widgets");
    await user.click(screen.getByRole("button", { name: /^label$/i }));

    expect(addWidget).toHaveBeenCalledWith(
      "label",
      expect.any(Number),
      expect.any(Number),
      undefined,
      CANVAS_CONSTRAINTS,
    );
  });

  it("restores the starter task list from the widget picker", async () => {
    const user = userEvent.setup();
    const onRestoreStarterTasks = vi.fn();
    const { container } = renderCanvas({
      starterTasksAvailable: true,
      onRestoreStarterTasks,
    });

    await openPickerPanel(user, container, "widgets");
    await user.click(
      screen.getByRole("button", { name: /^starter task list$/i }),
    );

    expect(onRestoreStarterTasks).toHaveBeenCalledOnce();
  });

  it("disables the Clock row when a clock is already pinned", async () => {
    const user = userEvent.setup();
    const addWidget = vi.fn();
    mocks.homeWidgetState.constraints = CANVAS_CONSTRAINTS;

    const { container } = renderCanvas({
      instances: [widget()],
      mutations: { addWidget },
    });

    await openPickerPanel(user, container, "widgets");

    const clockRow = screen.getByRole("button", { name: /^clock$/i });
    expect(clockRow).toBeDisabled();
    await user.click(clockRow);

    expect(addWidget).not.toHaveBeenCalled();
  });

  it("adds an agent pin with the selected agent id", async () => {
    const user = userEvent.setup();
    const addWidget = vi.fn();
    mocks.homeWidgetState.constraints = CANVAS_CONSTRAINTS;

    const { container } = renderCanvas({ mutations: { addWidget } });

    await openPickerPanel(user, container, "agent");
    await user.type(screen.getByPlaceholderText("Search"), "two");
    await user.click(screen.getByRole("button", { name: /agent two/i }));

    expect(addWidget).toHaveBeenCalledWith(
      "agentPin",
      100,
      120,
      { agentId: "agent-2" },
      CANVAS_CONSTRAINTS,
    );
  });

  it("adds pins at the cursor in the current camera space", async () => {
    const user = userEvent.setup();
    const addWidget = vi.fn();
    mocks.homeWidgetState.camera = {
      centerX: 0,
      centerY: 0,
      zoomBps: 12_500,
    };
    mocks.homeWidgetState.constraints = CANVAS_CONSTRAINTS;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      canvasRect(),
    );

    const { container } = renderCanvas({ mutations: { addWidget } });
    const canvas = container.firstElementChild as Element;

    fireEvent.contextMenu(canvas, {
      clientX: 500,
      clientY: 360,
    });
    await user.click(screen.getByRole("button", { name: PANEL_LABELS.agent }));
    await user.click(screen.getByRole("button", { name: /agent two/i }));

    expect(addWidget).toHaveBeenCalledWith(
      "agentPin",
      80,
      48,
      { agentId: "agent-2" },
      CANVAS_CONSTRAINTS,
    );
  });

  it("lists only visible unarchived chats for chat pins", async () => {
    const user = userEvent.setup();
    const addWidget = vi.fn();

    const { container } = renderCanvas({ mutations: { addWidget } });

    await openPickerPanel(user, container, "chat");

    expect(screen.getByRole("button", { name: /first chat/i })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /empty chat/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /archived chat/i })).toBeNull();

    await user.click(screen.getByRole("button", { name: /first chat/i }));

    expect(addWidget).toHaveBeenCalledWith(
      "chatPin",
      100,
      120,
      { sessionId: "session-1" },
      expect.objectContaining({ maxItems: 100 }),
    );
  });

  it("loads additional chat metadata once per search query", async () => {
    const user = userEvent.setup();
    mocks.hasMoreSessions = true;

    const { container, rerender } = renderCanvas();

    await openPickerPanel(user, container, "chat");
    expect(mocks.loadMoreSessions).not.toHaveBeenCalled();

    await user.type(screen.getByRole("textbox", { name: "Search" }), "x");

    await waitFor(() => {
      expect(mocks.loadMoreSessions).toHaveBeenCalledTimes(1);
    });

    mocks.isLoadingMoreSessions = true;
    rerender(
      <PickerTestProvider>
        <WidgetCanvas instances={[]} mutations={mutationHandlers()} />
      </PickerTestProvider>,
    );
    mocks.isLoadingMoreSessions = false;
    rerender(
      <PickerTestProvider>
        <WidgetCanvas instances={[]} mutations={mutationHandlers()} />
      </PickerTestProvider>,
    );

    expect(mocks.loadMoreSessions).toHaveBeenCalledTimes(1);

    await user.type(screen.getByRole("textbox", { name: "Search" }), "y");

    await waitFor(() => {
      expect(mocks.loadMoreSessions).toHaveBeenCalledTimes(2);
    });
  });

  it("searches chat picker project metadata without displaying it in rows", async () => {
    const user = userEvent.setup();

    const { container } = renderCanvas();

    await openPickerPanel(user, container, "chat");
    await user.type(screen.getByPlaceholderText("Search"), "alpha");

    expect(screen.getByRole("button", { name: /first chat/i })).toBeVisible();
    expect(screen.queryByText("Alpha Project")).toBeNull();
  });

  it("shows project context on pinned chat widgets", () => {
    renderCanvas({
      instances: [
        chatWidget({
          state: { sessionId: "session-1" },
        }),
      ],
    });

    expect(screen.getByText("First chat")).toBeVisible();
    expect(screen.getByText(/Alpha Project/)).toBeVisible();
  });

  it("clips minimized chat pins and renders markdown titles", () => {
    const originalSession = mocks.sessions[0];
    mocks.sessions[0] = {
      ...originalSession,
      title: "**Find Claude Code Session file**",
    };

    try {
      renderCanvas({
        instances: [
          chatWidget({
            state: { sessionId: "session-1" },
            width: 188,
            height: 72,
          }),
        ],
      });

      const emphasizedTitle = screen.getByText("Find Claude Code Session file");
      expect(emphasizedTitle.tagName).toBe("STRONG");
      expect(screen.queryByText(/\*\*Find Claude Code Session file\*\*/)).toBe(
        null,
      );
      expect(emphasizedTitle.closest("button")).toHaveClass("overflow-hidden");
      expect(screen.getByText(/Alpha Project/)).toHaveClass("truncate");
    } finally {
      mocks.sessions[0] = originalSession;
    }
  });

  it("adds a project artifact pin with the selected project id", async () => {
    const user = userEvent.setup();
    const addWidget = vi.fn();
    mocks.homeWidgetState.constraints = CANVAS_CONSTRAINTS;

    const { container } = renderCanvas({ mutations: { addWidget } });

    await openPickerPanel(user, container, "project");
    await user.type(screen.getByPlaceholderText("Search"), "beta");
    await user.click(screen.getByRole("button", { name: /beta project/i }));

    expect(addWidget).toHaveBeenCalledWith(
      "projectArtifactPin",
      100,
      120,
      { projectId: "project-2" },
      CANVAS_CONSTRAINTS,
    );
  });

  it("pauses project artifact widgets outside the visible canvas viewport", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      canvasRect(),
    );

    renderCanvas({
      instances: [
        widget({
          id: "visible-project-widget",
          type: "projectArtifactPin",
          state: { projectId: "project-1" },
          x: 100,
          y: 100,
        }),
        widget({
          id: "offscreen-project-widget",
          type: "projectArtifactPin",
          state: { projectId: "project-2" },
          x: 2000,
          y: 100,
        }),
      ],
    });

    const previews = screen.getAllByTestId("project-artifact-preview");
    expect(previews[0]).toHaveAttribute("data-render-paused", "false");
    expect(previews[1]).toHaveAttribute("data-render-paused", "true");
  });

  it("disables already pinned project targets", async () => {
    const user = userEvent.setup();
    const addWidget = vi.fn();

    const { container } = renderCanvas({
      instances: [
        widget({
          id: "project-widget",
          type: "projectArtifactPin",
          state: { projectId: "project-1" },
        }),
      ],
      mutations: { addWidget },
    });

    await openPickerPanel(user, container, "project");

    const pinnedProject = screen
      .getAllByRole("button", { name: /alpha project/i })
      .find((button) => button.hasAttribute("disabled"));
    if (!pinnedProject) {
      throw new Error("Expected pinned project picker row");
    }
    expect(pinnedProject).toBeDisabled();
    await user.click(pinnedProject);

    expect(addWidget).not.toHaveBeenCalled();
  });

  it("loads and adds automation pins from the picker", async () => {
    const user = userEvent.setup();
    const addWidget = vi.fn();

    const { container } = renderCanvas({ mutations: { addWidget } });

    await openPickerPanel(user, container, "automation");
    await user.click(
      await screen.findByRole("button", { name: /daily pr summary/i }),
    );

    expect(addWidget).toHaveBeenCalledWith(
      "automationOutputPin",
      100,
      120,
      { automationId: "automation-1" },
      expect.objectContaining({ maxItems: 100 }),
    );
  });

  it("renders automation widget output with inline markdown formatting", async () => {
    mocks.getAutomationTiles.mockResolvedValue({
      tiles: [
        {
          id: "automation-1",
          title: "Daily Bird Poem",
          latestRunStatus: "TILE_RUN_STATUS_SUCCESS",
          lastSuccessAt: "2026-05-20T12:00:00.000Z",
          latestRenderedData: {
            summary: "Today's poem features the **Great Blue Heron**.",
          },
        },
      ],
    });

    renderCanvas({
      instances: [
        widget({
          id: "automation-widget",
          type: "automationOutputPin",
          width: 244,
          height: 213,
        }),
      ],
    });

    const emphasizedText = await screen.findByText("Great Blue Heron");
    expect(emphasizedText.tagName).toBe("STRONG");
    expect(screen.queryByText(/\*\*Great Blue Heron\*\*/)).toBeNull();
  });

  it("skips persisted automation widgets when automations are disabled", () => {
    mocks.profileCapabilities.automations = false;

    const { container } = renderCanvas({
      instances: [
        widget({
          id: "automation-widget",
          type: "automationOutputPin",
          width: 244,
          height: 213,
          state: { automationId: "automation-1" },
        }),
      ],
    });

    expect(container.querySelector(HOME_WIDGET_NODE_SELECTOR)).toBeNull();
    expect(
      screen.queryByText(/automation unavailable/i),
    ).not.toBeInTheDocument();
    expect(mocks.getAutomationTile).not.toHaveBeenCalled();
    expect(mocks.getAutomationTiles).not.toHaveBeenCalled();
  });

  it("skips the persisted automations onboarding sticky when automations are disabled", () => {
    mocks.profileCapabilities.automations = false;

    const { container } = renderCanvas({
      instances: [
        stickyNoteWidget({
          id: "automation-sticky",
          state: { noteId: "onboarding:manage-automations" },
        }),
      ],
    });

    expect(container.querySelector(HOME_WIDGET_NODE_SELECTOR)).toBeNull();
    expect(screen.queryByText("Manage automations")).not.toBeInTheDocument();
  });

  it("keeps loaded automations cached across panel switches", async () => {
    const user = userEvent.setup();

    const { container } = renderCanvas();

    await openPickerPanel(user, container, "automation");
    expect(
      await screen.findByRole("button", { name: /daily pr summary/i }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: /back/i }));
    await user.click(screen.getByRole("button", { name: /^automations$/i }));

    expect(mocks.getAutomationTiles).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: /daily pr summary/i }),
    ).toBeVisible();
  });

  it("keeps automation load errors scoped to the automation picker", async () => {
    const user = userEvent.setup();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getAutomationTiles.mockRejectedValueOnce(new Error("failed"));

    const { container } = renderCanvas();

    await openPickerPanel(user, container, "automation");
    expect(await screen.findByText("Could not load items.")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /back/i }));
    await user.click(screen.getByRole("button", { name: /^project$/i }));

    expect(screen.queryByText("Could not load items.")).toBeNull();
  });

  it("disables already pinned picker targets", async () => {
    const user = userEvent.setup();
    const addWidget = vi.fn();

    const { container } = renderCanvas({
      instances: [agentWidget()],
      mutations: { addWidget },
    });

    await openPickerPanel(user, container, "agent");

    const pinnedAgent = screen
      .getAllByRole("button", { name: /agent one/i })
      .find((button) => button.hasAttribute("disabled"));
    if (!pinnedAgent) {
      throw new Error("Expected pinned agent picker row");
    }
    expect(pinnedAgent).toBeDisabled();
    await user.click(pinnedAgent);

    expect(addWidget).not.toHaveBeenCalled();
  });

  it("unpins a widget from the context menu", async () => {
    const user = userEvent.setup();
    const removeWidget = vi.fn();
    const moveWidget = vi.fn();

    renderCanvas({
      instances: [agentWidget()],
      mutations: { removeWidget, moveWidget },
    });

    await user.pointer({
      keys: "[MouseRight]",
      target: screen.getByRole("group", { name: /pin an agent/i }),
    });
    await user.click(screen.getByText("Unpin"));

    expect(removeWidget).toHaveBeenCalledWith("agent-widget");
    // Right-click → Unpin must not start a widget drag.
    expect(moveWidget).not.toHaveBeenCalled();
  });
});
