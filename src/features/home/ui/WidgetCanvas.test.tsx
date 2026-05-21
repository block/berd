import {
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { WidgetCanvas } from "./WidgetCanvas";

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
      icon: "tabler:code",
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

type RenderCanvasOptions = WidgetNavigationHandlers & {
  instances?: WidgetInstance[];
  mutations?: Partial<WidgetMutationHandlers>;
};

function renderCanvas({
  instances = [],
  mutations = {},
  ...navigation
}: RenderCanvasOptions = {}) {
  return render(
    <WidgetCanvas
      instances={instances}
      mutations={mutationHandlers(mutations)}
      {...navigation}
    />,
  );
}

async function openPickerPanel(
  user: ReturnType<typeof userEvent.setup>,
  container: HTMLElement,
  panel: "display" | "agents" | "chats" | "automations",
) {
  fireEvent.doubleClick(container.firstElementChild as Element, {
    clientX: 100,
    clientY: 120,
  });
  await user.click(
    screen.getByRole("button", { name: new RegExp(panel, "i") }),
  );
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
    const agentNode = agentButton.closest("[data-home-widget-node]");
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

    const clockNode = container.querySelector("[data-home-widget-node]");
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
    const clockNode = container.querySelector("[data-home-widget-node]");
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

  it("saves the camera after wheel zoom settles", () => {
    vi.useFakeTimers();
    const { container } = renderCanvas();
    const canvas = container.firstElementChild as HTMLElement;

    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(canvasRect());

    fireEvent.wheel(canvas, {
      clientX: 400,
      clientY: 300,
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

  it("adds a widget from the picker after double-clicking the canvas", async () => {
    const user = userEvent.setup();
    const addWidget = vi.fn();
    mocks.homeWidgetState.camera = {
      centerX: 200,
      centerY: -100,
      zoomBps: 12_500,
    };
    mocks.homeWidgetState.constraints = CANVAS_CONSTRAINTS;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      canvasRect({ left: 25, top: 50, width: 1000, height: 800 }),
    );

    const { container } = renderCanvas({ mutations: { addWidget } });

    fireEvent.doubleClick(container.firstElementChild as Element, {
      clientX: 345,
      clientY: 290,
    });
    await user.click(screen.getByRole("button", { name: /display/i }));
    await user.click(screen.getByRole("button", { name: /clock/i }));

    expect(addWidget).toHaveBeenCalledWith(
      "clock",
      56,
      -228,
      undefined,
      CANVAS_CONSTRAINTS,
    );
  });

  it("adds an agent pin with the selected agent id", async () => {
    const user = userEvent.setup();
    const addWidget = vi.fn();
    mocks.homeWidgetState.constraints = CANVAS_CONSTRAINTS;

    const { container } = renderCanvas({ mutations: { addWidget } });

    await openPickerPanel(user, container, "agents");
    await user.type(screen.getByPlaceholderText("Search agents"), "two");
    await user.click(screen.getByRole("button", { name: /agent two/i }));

    expect(addWidget).toHaveBeenCalledWith(
      "agentPin",
      100,
      120,
      { agentId: "agent-2" },
      CANVAS_CONSTRAINTS,
    );
  });

  it("lists only visible unarchived chats for chat pins", async () => {
    const user = userEvent.setup();
    const addWidget = vi.fn();

    const { container } = renderCanvas({ mutations: { addWidget } });

    await openPickerPanel(user, container, "chats");

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

    await openPickerPanel(user, container, "chats");
    expect(mocks.loadMoreSessions).not.toHaveBeenCalled();

    await user.type(screen.getByRole("textbox", { name: "Search chats" }), "x");

    await waitFor(() => {
      expect(mocks.loadMoreSessions).toHaveBeenCalledTimes(1);
    });

    mocks.isLoadingMoreSessions = true;
    rerender(<WidgetCanvas instances={[]} mutations={mutationHandlers()} />);
    mocks.isLoadingMoreSessions = false;
    rerender(<WidgetCanvas instances={[]} mutations={mutationHandlers()} />);

    expect(mocks.loadMoreSessions).toHaveBeenCalledTimes(1);

    await user.type(screen.getByRole("textbox", { name: "Search chats" }), "y");

    await waitFor(() => {
      expect(mocks.loadMoreSessions).toHaveBeenCalledTimes(2);
    });
  });

  it("searches chat picker project metadata without displaying it in rows", async () => {
    const user = userEvent.setup();

    const { container } = renderCanvas();

    await openPickerPanel(user, container, "chats");
    await user.type(screen.getByPlaceholderText("Search chats"), "alpha");

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

  it("loads and adds automation pins from the picker", async () => {
    const user = userEvent.setup();
    const addWidget = vi.fn();

    const { container } = renderCanvas({ mutations: { addWidget } });

    await openPickerPanel(user, container, "automations");
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

    await openPickerPanel(user, container, "automations");
    expect(
      await screen.findByRole("button", { name: /daily pr summary/i }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: /back/i }));
    await user.click(screen.getByRole("button", { name: /automations/i }));

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

    await openPickerPanel(user, container, "automations");
    expect(await screen.findByText("Could not load items.")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /back/i }));
    await user.click(screen.getByRole("button", { name: /display/i }));

    expect(screen.queryByText("Could not load items.")).toBeNull();
    expect(screen.getByRole("button", { name: /clock/i })).toBeVisible();
  });

  it("disables already pinned picker targets", async () => {
    const user = userEvent.setup();
    const addWidget = vi.fn();

    const { container } = renderCanvas({
      instances: [agentWidget()],
      mutations: { addWidget },
    });

    await openPickerPanel(user, container, "agents");

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

    renderCanvas({
      instances: [widget()],
      mutations: { removeWidget },
    });

    await user.pointer({
      keys: "[MouseRight]",
      target: screen.getByText(/wed|sun|mon|tue|thu|fri|sat/i),
    });
    await user.click(screen.getByText("Unpin"));

    expect(removeWidget).toHaveBeenCalledWith("clock-widget");
    expect(HTMLElement.prototype.setPointerCapture).not.toHaveBeenCalled();
  });
});
