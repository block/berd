import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
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

const HOME_WIDGET_NODE_SELECTOR = `[${HOME_WIDGET_NODE_ATTR}]`;

const mocks = vi.hoisted(() => ({
  saveCamera: vi.fn(),
  getAutomationTiles: vi.fn(),
  loadMoreSessions: vi.fn(),
  hasMoreSessions: false,
  isLoadingMoreSessions: false,
  homeWidgetState: {
    camera: { centerX: 0, centerY: 0, zoomBps: 10_000 } as LayoutCamera,
    constraints: null as LayoutConstraints | null,
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

vi.mock("@/features/automations/api/kgooseAutomations", () => ({
  getAutomationTiles: mocks.getAutomationTiles,
}));

vi.mock("@/features/projects/stores/projectStore", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) =>
    selector({ projects: mocks.projects }),
}));

vi.mock("@/features/projects/artifact/ProjectArtifactPreview", () => ({
  ProjectArtifactPreview: ({ input }: { input: { name: string } }) => (
    <div data-testid="project-artifact-preview">{input.name}</div>
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
  onCreatePersona?: () => void;
  onCreateProject?: () => void;
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
    vi.useRealTimers();
    mocks.homeWidgetState.camera = { centerX: 0, centerY: 0, zoomBps: 10_000 };
    mocks.homeWidgetState.constraints = null;
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
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setDevicePixelRatio(1);
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
      instances: [widget({ x: 20.25, y: 30.25 })],
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
    expect(widgetContent.style.transform).toBe("scale(1.25)");
    expect(widgetContent.style.transformOrigin).toBe("top left");
    expect(widgetContent.style.width).toBe("240px");
    expect(widgetContent.style.height).toBe("240px");
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

    expect(screen.getByText("Welcome to Goose for Block")).toBeInTheDocument();
    expect(screen.getByText("Build an agent")).toBeInTheDocument();
    expect(screen.getByText("Start a project")).toBeInTheDocument();
    expect(screen.getByText("Teach Goose a skill")).toBeInTheDocument();
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
      instances: [widget()],
      mutations: { resizeWidget },
    });

    const canvas = container.firstElementChild as Element;
    const resizeHandle = screen.getByRole("button", {
      name: /resize clock/i,
    });

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

  it("offers Starter stickies and restores only missing onboarding notes", async () => {
    const user = userEvent.setup();
    const addWidget = vi.fn();
    mocks.homeWidgetState.constraints = CANVAS_CONSTRAINTS;

    const { container } = renderCanvas({
      instances: [
        stickyNoteWidget({
          id: "welcome-sticky",
          state: { noteId: "onboarding:welcome" },
        }),
        stickyNoteWidget({
          id: "build-agent-sticky",
          state: { noteId: "onboarding:build-agent" },
        }),
        stickyNoteWidget({
          id: "project-sticky",
          state: { noteId: "onboarding:start-project" },
        }),
        stickyNoteWidget({
          id: "home-sticky",
          state: { noteId: "onboarding:shape-home" },
        }),
        stickyNoteWidget({
          id: "automation-sticky",
          state: { noteId: "onboarding:manage-automations" },
        }),
      ],
      mutations: { addWidget },
    });

    await openPickerPanel(user, container, "widgets");
    await user.click(
      screen.getByRole("button", { name: /^starter stickies$/i }),
    );

    expect(addWidget).toHaveBeenCalledTimes(1);
    expect(addWidget).toHaveBeenCalledWith(
      "stickyNote",
      100,
      120,
      { noteId: "onboarding:reuse-workflows" },
      CANVAS_CONSTRAINTS,
    );
  });

  it("disables Starter stickies when all onboarding notes are pinned", async () => {
    const user = userEvent.setup();
    const addWidget = vi.fn();

    const { container } = renderCanvas({
      instances: [
        stickyNoteWidget({
          id: "welcome-sticky",
          state: { noteId: "onboarding:welcome" },
        }),
        stickyNoteWidget({
          id: "build-agent-sticky",
          state: { noteId: "onboarding:build-agent" },
        }),
        stickyNoteWidget({
          id: "project-sticky",
          state: { noteId: "onboarding:start-project" },
        }),
        stickyNoteWidget({
          id: "skills-sticky",
          state: { noteId: "onboarding:reuse-workflows" },
        }),
        stickyNoteWidget({
          id: "home-sticky",
          state: { noteId: "onboarding:shape-home" },
        }),
        stickyNoteWidget({
          id: "automation-sticky",
          state: { noteId: "onboarding:manage-automations" },
        }),
      ],
      mutations: { addWidget },
    });

    await openPickerPanel(user, container, "widgets");

    const starterStickiesRow = screen.getByRole("button", {
      name: /^starter stickies$/i,
    });
    expect(starterStickiesRow).toBeDisabled();
    await user.click(starterStickiesRow);

    expect(addWidget).not.toHaveBeenCalled();
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
