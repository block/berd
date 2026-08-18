import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TopBarActionsProvider,
  useTopBarActions,
} from "@/app/contexts/TopBarActionsContext";
import type { Layout } from "@/features/layout/api/layout";
import { BERDY_ONBOARDING_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { setExperimentEnabled } from "@/features/experiments/experimentPreferences";
import {
  getLayout,
  HOME_LAYOUT_ID,
  saveLayoutCamera,
  saveLayoutItems,
} from "@/features/layout/api/layout";
import { resetHomePinTelemetryForTests } from "../lib/homePinTelemetry";
import {
  trackHomeItemPinned,
  trackHomeItemUnpinned,
} from "../lib/homeTelemetry";
import {
  resetHomeWidgetStoreForTests,
  useHomeWidgetStore,
} from "../stores/homeWidgetStore";
import { HomeView } from "./HomeView";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import type { Persona } from "@/shared/types/agents";
import { markStarterAgentPinsEligible } from "@/features/home/onboarding/starterAgents";
import { StarterTasksProvider } from "@/features/home/onboarding/StarterTasksContext";
import { EMPTY_STARTER_TASK_COMPLETION } from "@/features/home/onboarding/starterTaskProgress";
import { markStarterHomeLayoutEligible } from "@/features/home/onboarding/starterHomeLayout";

const ONBOARDING_STICKIES_SEEDED_STORAGE_KEY =
  "goose:home:onboarding-stickies-seeded";

type WidgetCanvasProps = ComponentProps<
  typeof import("./WidgetCanvas").WidgetCanvas
>;

const widgetCanvasMock = vi.hoisted(() =>
  vi.fn((_props: WidgetCanvasProps) => <div>widget canvas</div>),
);
vi.mock("@/shared/api/agents", () => ({
  listPersonas: vi.fn(async () => useAgentStore.getState().personas),
}));

vi.mock("@/features/layout/api/layout", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/layout/api/layout")>();
  return {
    ...actual,
    getLayout: vi.fn(),
    saveLayoutCamera: vi.fn(),
    saveLayoutItems: vi.fn(),
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("./WidgetCanvas", () => ({
  WidgetCanvas: widgetCanvasMock,
}));

vi.mock("../lib/homeTelemetry", () => ({
  trackHomeItemPinned: vi.fn(),
  trackHomeItemUnpinned: vi.fn(),
}));

function layout(overrides: Partial<Layout> = {}): Layout {
  return {
    layoutId: HOME_LAYOUT_ID,
    itemRevision: 1,
    cameraRevision: 1,
    camera: { centerX: 0, centerY: 0, zoomBps: 10_000 },
    constraints: {
      minCenter: -100_000,
      maxCenter: 100_000,
      minSize: 1,
      maxSize: 10_000,
      minZoomBps: 1_000,
      maxZoomBps: 20_000,
      maxTitleOverrideLength: 120,
      maxItems: 100,
    },
    items: [
      {
        id: "00000000-0000-0000-0000-000000000001",
        kind: "clock",
        targetId: "widget:00000000-0000-0000-0000-000000000001",
        centerX: 240,
        centerY: 240,
        width: 240,
        height: 240,
        zIndex: 1,
        titleOverride: null,
      },
    ],
    ...overrides,
  };
}

function bundledPersona(displayName: string): Persona {
  return {
    id: `/Users/test/.agents/agents/${displayName.toLowerCase()}.md`,
    displayName,
    systemPrompt: "Help.",
    isBuiltin: false,
    writable: true,
    sourceProperties: {
      metadata: {
        berdBundled: true,
        berdBundledSource: displayName.toLowerCase(),
      },
    },
  };
}

function TopBarActionsHost() {
  const actions = useTopBarActions();
  return <div data-testid="topbar-actions">{actions}</div>;
}

function renderHomeView() {
  return render(<HomeView />);
}

function renderHomeViewWithProps(props: ComponentProps<typeof HomeView>) {
  return render(<HomeView {...props} />);
}

function renderHomeViewWithTopBarActions() {
  return render(
    <TopBarActionsProvider>
      <TopBarActionsHost />
      <HomeView />
    </TopBarActionsProvider>,
  );
}

function renderHomeViewWithVisibleStarterTasks() {
  return render(
    <StarterTasksProvider
      value={{
        completionState: EMPTY_STARTER_TASK_COMPLETION,
        enabled: true,
        visible: true,
        docked: false,
        selectedTaskId: null,
        starterProjectId: "onboarding-starter-project",
        omittedTaskIds: new Set(),
        onTaskSelect: vi.fn(),
        onTaskToggle: vi.fn(),
        onBackHome: vi.fn(),
        onCloseSecondary: vi.fn(),
        onDismiss: vi.fn(),
        onRestore: vi.fn(),
      }}
    >
      <HomeView />
    </StarterTasksProvider>,
  );
}

beforeEach(() => {
  resetHomeWidgetStoreForTests();
  resetHomePinTelemetryForTests();
  widgetCanvasMock.mockClear();
  vi.mocked(getLayout).mockReset();
  vi.mocked(saveLayoutItems).mockReset();
  vi.mocked(saveLayoutItems).mockImplementation(async (request) => ({
    ok: true,
    layout: layout({ items: request.items, itemRevision: 2 }),
  }));
  vi.mocked(saveLayoutCamera).mockReset();
  vi.mocked(saveLayoutCamera).mockImplementation(async (request) => ({
    ok: true,
    layout: layout({
      camera: request.camera,
      cameraRevision: 2,
      items:
        useHomeWidgetStore.getState().lastConfirmedLayout?.items ??
        layout().items,
    }),
  }));
  localStorage.clear();
  localStorage.setItem(ONBOARDING_STICKIES_SEEDED_STORAGE_KEY, "6");
  useAgentStore.setState({ personas: [], personasLoading: false });
  setExperimentEnabled(BERDY_ONBOARDING_EXPERIMENT_ID, false);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  });
});

describe("HomeView", () => {
  it("removes the starter task widget hit area after it is dismissed", async () => {
    vi.mocked(getLayout).mockResolvedValue(
      layout({
        items: [
          {
            id: "00000000-0000-0000-0000-000000000098",
            kind: "stickyNote",
            targetId: "onboarding:starter-tasks",
            centerX: 100,
            centerY: 100,
            width: 256,
            height: 196,
            zIndex: 2,
            titleOverride: null,
          },
        ],
      }),
    );

    render(
      <StarterTasksProvider
        value={{
          completionState: EMPTY_STARTER_TASK_COMPLETION,
          enabled: true,
          visible: false,
          docked: false,
          selectedTaskId: null,
          starterProjectId: null,
          omittedTaskIds: new Set(),
          onTaskSelect: vi.fn(),
          onTaskToggle: vi.fn(),
          onBackHome: vi.fn(),
          onCloseSecondary: vi.fn(),
          onDismiss: vi.fn(),
          onRestore: vi.fn(),
        }}
      >
        <HomeView />
      </StarterTasksProvider>,
    );
    await screen.findByText("widget canvas");

    expect(widgetCanvasMock.mock.lastCall?.[0].instances).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: expect.objectContaining({
            noteId: "onboarding:starter-tasks",
          }),
        }),
      ]),
    );
  });

  it("does not rearrange an existing complete starter Home without new-layout eligibility", async () => {
    setExperimentEnabled(BERDY_ONBOARDING_EXPERIMENT_ID, true);
    const bundledPersona = (displayName: string): Persona => ({
      id: `/Users/test/.agents/agents/${displayName.toLowerCase()}.md`,
      displayName,
      systemPrompt: "Help.",
      isBuiltin: false,
      writable: true,
      sourceProperties: {
        metadata: {
          berdBundled: true,
          berdBundledSource: displayName.toLowerCase(),
        },
      },
    });
    const personas = [bundledPersona("Tinker"), bundledPersona("Wildcard")];
    useAgentStore.setState({ personas, personasLoading: false });
    const existingItems: Layout["items"] = [
      ...layout().items,
      {
        id: "tour",
        kind: "stickyNote",
        targetId: "onboarding:tour",
        centerX: -100,
        centerY: -100,
        width: 448,
        height: 180,
        zIndex: 2,
        titleOverride: null,
      },
      {
        id: "tasks",
        kind: "stickyNote",
        targetId: "onboarding:starter-tasks",
        centerX: 100,
        centerY: 100,
        width: 256,
        height: 224,
        zIndex: 3,
        titleOverride: null,
      },
      {
        id: "project",
        kind: "stickyNote",
        targetId: "onboarding:starter-project",
        centerX: 300,
        centerY: 300,
        width: 440,
        height: 440,
        zIndex: 4,
        titleOverride: null,
      },
      ...personas.map((persona, index) => ({
        id: `agent-${index}`,
        kind: "persona" as const,
        targetId: persona.id,
        centerX: 500 + index * 220,
        centerY: 500,
        width: 200,
        height: 220,
        zIndex: 5 + index,
        titleOverride: null,
      })),
    ];
    vi.mocked(getLayout).mockResolvedValue(layout({ items: existingItems }));

    renderHomeViewWithVisibleStarterTasks();
    await screen.findByText("widget canvas");
    await waitFor(() =>
      expect(useHomeWidgetStore.getState().loadStatus).toBe("ready"),
    );

    expect(saveLayoutCamera).not.toHaveBeenCalled();
    expect(
      useHomeWidgetStore
        .getState()
        .instances.find((item) => item.type === "clock"),
    ).toMatchObject({
      width: 240,
      height: 240,
      x: 120,
      y: 120,
    });
  });

  it("arranges a newly seeded Home with the exact fractional clock center", async () => {
    setExperimentEnabled(BERDY_ONBOARDING_EXPERIMENT_ID, true);
    const bundledPersona = (displayName: string): Persona => ({
      id: `/Users/test/.agents/agents/${displayName.toLowerCase()}.md`,
      displayName,
      systemPrompt: "Help.",
      isBuiltin: false,
      writable: true,
      sourceProperties: {
        metadata: {
          berdBundled: true,
          berdBundledSource: displayName.toLowerCase(),
        },
      },
    });
    const personas = [bundledPersona("Tinker"), bundledPersona("Wildcard")];
    useAgentStore.setState({ personas, personasLoading: false });
    markStarterHomeLayoutEligible();
    const existingItems: Layout["items"] = [
      ...layout().items,
      {
        id: "tour",
        kind: "stickyNote",
        targetId: "onboarding:tour",
        centerX: -100,
        centerY: -100,
        width: 448,
        height: 180,
        zIndex: 2,
        titleOverride: null,
      },
      {
        id: "tasks",
        kind: "stickyNote",
        targetId: "onboarding:starter-tasks",
        centerX: 100,
        centerY: 100,
        width: 256,
        height: 224,
        zIndex: 3,
        titleOverride: null,
      },
      {
        id: "project",
        kind: "stickyNote",
        targetId: "onboarding:starter-project",
        centerX: 300,
        centerY: 300,
        width: 440,
        height: 440,
        zIndex: 4,
        titleOverride: null,
      },
      ...personas.map((persona, index) => ({
        id: `agent-${index}`,
        kind: "persona" as const,
        targetId: persona.id,
        centerX: 500 + index * 220,
        centerY: 500,
        width: 200,
        height: 220,
        zIndex: 5 + index,
        titleOverride: null,
      })),
    ];
    vi.mocked(getLayout).mockResolvedValue(layout({ items: existingItems }));

    renderHomeViewWithVisibleStarterTasks();
    await waitFor(() =>
      expect(
        useHomeWidgetStore
          .getState()
          .instances.find((item) => item.type === "clock"),
      ).toMatchObject({
        width: 156,
        height: 156,
        x: 522,
        y: -274,
      }),
    );
    await waitFor(() => expect(saveLayoutCamera).toHaveBeenCalled());
    const savedClock = vi
      .mocked(saveLayoutItems)
      .mock.calls.flatMap(([request]) => request.items)
      .findLast((item) => item.kind === "clock" && item.width === 156);
    expect(savedClock).toMatchObject({
      centerX: 600,
      centerY: -196,
      width: 156,
      height: 156,
    });
  });

  it("does not offer starter tasks when the experiment is disabled", async () => {
    vi.mocked(getLayout).mockResolvedValue(layout());
    render(
      <StarterTasksProvider
        value={{
          completionState: EMPTY_STARTER_TASK_COMPLETION,
          enabled: false,
          visible: false,
          docked: false,
          selectedTaskId: null,
          starterProjectId: null,
          omittedTaskIds: new Set(),
          onTaskSelect: vi.fn(),
          onTaskToggle: vi.fn(),
          onBackHome: vi.fn(),
          onCloseSecondary: vi.fn(),
          onDismiss: vi.fn(),
          onRestore: vi.fn(),
        }}
      >
        <HomeView />
      </StarterTasksProvider>,
    );
    await screen.findByText("widget canvas");

    expect(widgetCanvasMock.mock.lastCall?.[0].starterTasksAvailable).toBe(
      false,
    );
  });

  it("keeps the starter project cube after starter tasks are dismissed", async () => {
    vi.mocked(getLayout).mockResolvedValue(
      layout({
        items: [
          {
            id: "00000000-0000-0000-0000-000000000099",
            kind: "stickyNote",
            targetId: "onboarding:starter-project",
            centerX: 500,
            centerY: 200,
            width: 400,
            height: 400,
            zIndex: 2,
            titleOverride: null,
          },
        ],
      }),
    );

    render(
      <StarterTasksProvider
        value={{
          completionState: EMPTY_STARTER_TASK_COMPLETION,
          enabled: true,
          visible: false,
          docked: false,
          selectedTaskId: null,
          starterProjectId: null,
          omittedTaskIds: new Set(),
          onTaskSelect: vi.fn(),
          onTaskToggle: vi.fn(),
          onBackHome: vi.fn(),
          onCloseSecondary: vi.fn(),
          onDismiss: vi.fn(),
          onRestore: vi.fn(),
        }}
      >
        <HomeView />
      </StarterTasksProvider>,
    );
    await screen.findByText("widget canvas");

    expect(widgetCanvasMock.mock.lastCall?.[0].instances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "onboardingProjectArtifact" }),
      ]),
    );
  });

  it("does not add bundled starter agents to an existing customized Home", async () => {
    vi.mocked(getLayout).mockResolvedValue(layout());
    const bundledPersona = (displayName: string): Persona => ({
      id: `/Users/test/.agents/agents/${displayName.toLowerCase()}.md`,
      displayName,
      systemPrompt: "Help.",
      isBuiltin: false,
      writable: true,
      sourceProperties: {
        metadata: { berdBundled: true, berdBundledSource: "tinker" },
      },
    });
    useAgentStore.setState({
      personas: [
        bundledPersona("Tinker"),
        bundledPersona("Berdy"),
        bundledPersona("Wildcard"),
      ],
      personasLoading: false,
    });

    renderHomeView();
    await screen.findByText("widget canvas");

    expect(
      useHomeWidgetStore
        .getState()
        .instances.filter((instance) => instance.type === "agentPin"),
    ).toHaveLength(0);
  });

  it("recovers starter-agent pins after the base Home loads without them", async () => {
    setExperimentEnabled(BERDY_ONBOARDING_EXPERIMENT_ID, true);
    vi.mocked(getLayout).mockResolvedValue(layout({ items: [] }));
    markStarterAgentPinsEligible();
    useAgentStore.setState({ personas: [], personasLoading: false });

    const view = renderHomeView();
    await screen.findByText("widget canvas");
    expect(
      useHomeWidgetStore
        .getState()
        .instances.filter((instance) => instance.type === "agentPin"),
    ).toHaveLength(0);

    const personas: Persona[] = [
      {
        id: "/Users/test/.agents/agents/tinker.md",
        displayName: "Tinker",
        systemPrompt: "Help.",
        isBuiltin: false,
        writable: true,
        sourceProperties: {
          metadata: { berdBundled: true, berdBundledSource: "tinker" },
        },
      },
      {
        id: "/Users/test/.agents/agents/wildcard.md",
        displayName: "Wildcard",
        systemPrompt: "Help.",
        isBuiltin: false,
        writable: true,
        sourceProperties: {
          metadata: {
            berdBundled: true,
            berdBundledSource: "wildcard",
          },
        },
      },
    ];
    useAgentStore.setState({ personas, personasLoading: false });
    view.rerender(<HomeView />);

    await waitFor(() =>
      expect(
        useHomeWidgetStore
          .getState()
          .instances.filter((instance) => instance.type === "agentPin"),
      ).toHaveLength(2),
    );
  });

  it("adds bundled starter agents to a newly seeded Home", async () => {
    setExperimentEnabled(BERDY_ONBOARDING_EXPERIMENT_ID, true);
    vi.mocked(getLayout).mockResolvedValue(layout({ items: [] }));
    const bundledPersona = (displayName: string): Persona => ({
      id: `/Users/test/.agents/agents/${displayName.toLowerCase()}.md`,
      displayName,
      systemPrompt: "Help.",
      isBuiltin: false,
      writable: true,
      sourceProperties: {
        metadata: {
          berdBundled: true,
          berdBundledSource: displayName.toLowerCase(),
        },
      },
    });
    const personas = [bundledPersona("Tinker"), bundledPersona("Wildcard")];
    useAgentStore.setState({ personas, personasLoading: false });
    renderHomeView();

    await waitFor(() =>
      expect(
        useHomeWidgetStore
          .getState()
          .instances.filter((instance) => instance.type === "agentPin"),
      ).toHaveLength(2),
    );
    expect(
      useHomeWidgetStore
        .getState()
        .instances.filter((instance) => instance.type === "agentPin")
        .map((instance) => instance.state?.agentId),
    ).toEqual(personas.map((persona) => persona.id));
  });

  it("seeds starter agents without emitting pin telemetry", async () => {
    vi.mocked(getLayout).mockResolvedValue(layout());
    const personas = [bundledPersona("Tinker"), bundledPersona("Wildcard")];
    useAgentStore.setState({ personas, personasLoading: false });
    markStarterAgentPinsEligible();

    renderHomeView();

    // The seeded marker is written only after the runtime confirms the save,
    // so waiting on it settles the whole seed lifecycle.
    await waitFor(() =>
      expect(
        localStorage.getItem("goose:home:starter-agent-pins-seeded-v5"),
      ).toBe("1"),
    );
    expect(
      useHomeWidgetStore
        .getState()
        .instances.filter((instance) => instance.type === "agentPin"),
    ).toHaveLength(2);
    expect(trackHomeItemPinned).not.toHaveBeenCalled();
    expect(trackHomeItemUnpinned).not.toHaveBeenCalled();
  });

  it("keeps failed starter-agent recovery eligible without retrying forever", async () => {
    vi.mocked(getLayout).mockResolvedValue(layout());
    const personas = [bundledPersona("Tinker"), bundledPersona("Wildcard")];
    useAgentStore.setState({ personas, personasLoading: false });
    markStarterAgentPinsEligible();
    vi.mocked(saveLayoutItems).mockRejectedValue(new Error("save failed"));

    renderHomeView();

    await waitFor(() => expect(saveLayoutItems).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(saveLayoutItems).toHaveBeenCalledOnce();
    expect(
      localStorage.getItem("goose:home:starter-agent-pins-seeded-v5"),
    ).toBeNull();
    expect(trackHomeItemPinned).not.toHaveBeenCalled();
    expect(trackHomeItemUnpinned).not.toHaveBeenCalled();
  });

  it("keeps pin/unpin telemetry for canvas-native user mutations", async () => {
    vi.mocked(getLayout).mockResolvedValue(layout());

    renderHomeView();
    await screen.findByText("widget canvas");

    const canvasProps = widgetCanvasMock.mock.calls.at(-1)?.[0];
    if (!canvasProps) {
      throw new Error("WidgetCanvas was not rendered");
    }

    act(() => {
      canvasProps.mutations.addWidget("agentPin", 480, 480, {
        agentId: "agent-user-pinned",
      });
    });
    // Optimistic canvas mutation: nothing is reported until the save confirms.
    expect(trackHomeItemPinned).not.toHaveBeenCalled();
    await waitFor(() => expect(saveLayoutItems).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(trackHomeItemPinned).toHaveBeenCalledOnce());
    expect(trackHomeItemPinned).toHaveBeenCalledWith({ kind: "agent" });

    const pinned = useHomeWidgetStore
      .getState()
      .instances.find((instance) => instance.type === "agentPin");
    if (!pinned) {
      throw new Error("agent pin was not added");
    }
    act(() => {
      canvasProps.mutations.removeWidget(pinned.id);
    });
    expect(trackHomeItemUnpinned).not.toHaveBeenCalled();
    await waitFor(() => expect(saveLayoutItems).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(trackHomeItemUnpinned).toHaveBeenCalledOnce());
    expect(trackHomeItemUnpinned).toHaveBeenCalledWith({ kind: "agent" });
    expect(trackHomeItemPinned).toHaveBeenCalledOnce();
  });

  it("reports no pin telemetry when the canvas save fails", async () => {
    vi.mocked(getLayout).mockResolvedValue(layout());
    vi.mocked(saveLayoutItems).mockRejectedValueOnce(new Error("save failed"));

    renderHomeView();
    await screen.findByText("widget canvas");
    vi.mocked(trackHomeItemPinned).mockClear();
    vi.mocked(trackHomeItemUnpinned).mockClear();

    const canvasProps = widgetCanvasMock.mock.calls.at(-1)?.[0];
    if (!canvasProps) {
      throw new Error("WidgetCanvas was not rendered");
    }

    act(() => {
      canvasProps.mutations.addWidget("agentPin", 480, 480, {
        agentId: "agent-user-pinned",
      });
    });

    await waitFor(() => expect(saveLayoutItems).toHaveBeenCalledTimes(1));
    // The failed save rolls the canvas back to the last confirmed layout, so
    // the pin the user saw never existed.
    await waitFor(() =>
      expect(
        useHomeWidgetStore
          .getState()
          .instances.some((instance) => instance.type === "agentPin"),
      ).toBe(false),
    );
    expect(trackHomeItemPinned).not.toHaveBeenCalled();
    expect(trackHomeItemUnpinned).not.toHaveBeenCalled();
  });

  it("removes Berdy from the canvas when its experiment is disabled", async () => {
    setExperimentEnabled(BERDY_ONBOARDING_EXPERIMENT_ID, false);
    vi.mocked(getLayout).mockResolvedValue(
      layout({
        items: [
          ...layout().items,
          {
            id: "00000000-0000-0000-0000-000000000002",
            kind: "stickyNote",
            targetId: "onboarding:tour",
            centerX: 888,
            centerY: 378,
            width: 448,
            height: 180,
            zIndex: 2,
            titleOverride: null,
          },
        ],
      }),
    );

    renderHomeView();
    await screen.findByText("widget canvas");

    expect(widgetCanvasMock.mock.calls.at(-1)?.[0].instances).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "onboardingTour" }),
      ]),
    );
    await waitFor(() => {
      expect(
        useHomeWidgetStore
          .getState()
          .instances.some((instance) => instance.type === "onboardingTour"),
      ).toBe(false);
    });
    expect(useHomeWidgetStore.getState().instances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "stickyNote",
          state: expect.objectContaining({ noteId: "onboarding:welcome" }),
        }),
      ]),
    );
    expect(saveLayoutCamera).not.toHaveBeenCalled();
  });

  it("persists Berdy on live opt-in without moving the camera", async () => {
    setExperimentEnabled(BERDY_ONBOARDING_EXPERIMENT_ID, false);
    vi.mocked(getLayout).mockResolvedValue(
      layout({
        items: [
          ...layout().items,
          {
            id: "00000000-0000-0000-0000-000000000002",
            kind: "stickyNote",
            targetId: "onboarding:welcome",
            centerX: -248,
            centerY: -152,
            width: 224,
            height: 196,
            zIndex: 2,
            titleOverride: null,
          },
        ],
      }),
    );

    renderHomeView();
    await screen.findByText("widget canvas");
    vi.mocked(saveLayoutItems).mockClear();

    act(() => {
      setExperimentEnabled(BERDY_ONBOARDING_EXPERIMENT_ID, true);
    });

    await waitFor(() => expect(saveLayoutItems).toHaveBeenCalledOnce());
    expect(useHomeWidgetStore.getState().instances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "onboardingTour" }),
      ]),
    );
    expect(
      useHomeWidgetStore
        .getState()
        .instances.some(
          (instance) => instance.state?.noteId === "onboarding:welcome",
        ),
    ).toBe(false);
    expect(saveLayoutCamera).not.toHaveBeenCalled();
  });

  it("reconciles Berdy when Home mounts after opt-in", async () => {
    setExperimentEnabled(BERDY_ONBOARDING_EXPERIMENT_ID, true);
    useHomeWidgetStore.setState({
      instances: [
        {
          id: "clock",
          type: "clock",
          x: 120,
          y: 120,
          z: 1,
          width: 240,
          height: 240,
        },
        {
          id: "welcome",
          type: "stickyNote",
          x: -360,
          y: -240,
          z: 2,
          width: 224,
          height: 196,
          state: { noteId: "onboarding:welcome" },
        },
      ],
      loadStatus: "ready",
      itemRevision: 1,
      camera: { centerX: 0, centerY: 0, zoomBps: 10_000 },
      cameraRevision: 1,
      constraints: layout().constraints,
    });

    renderHomeView();

    await waitFor(() => expect(saveLayoutItems).toHaveBeenCalledOnce());
    expect(useHomeWidgetStore.getState().instances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "onboardingTour" }),
      ]),
    );
    expect(saveLayoutCamera).not.toHaveBeenCalled();
  });

  it("calls initialize on mount", async () => {
    vi.mocked(getLayout).mockResolvedValue(layout());

    renderHomeView();

    await screen.findByText("widget canvas");
    expect(getLayout).toHaveBeenCalledWith(HOME_LAYOUT_ID);
  });

  it("shows loading state without inline composer", () => {
    vi.mocked(getLayout).mockReturnValue(new Promise(() => {}));

    renderHomeView();

    expect(screen.getByText("Loading widgets...")).toBeInTheDocument();
    expect(screen.queryByText("home composer")).not.toBeInTheDocument();
  });

  it("shows error actions without inline composer", async () => {
    vi.mocked(getLayout).mockRejectedValue("raw backend error");

    renderHomeView();

    expect(
      await screen.findByText("Widgets could not be loaded."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy details" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("home composer")).not.toBeInTheDocument();
  });

  it("copy details writes the raw error string and shows a toast", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.mocked(getLayout).mockRejectedValue("raw backend error");

    renderHomeView();
    await user.click(
      await screen.findByRole("button", { name: "Copy details" }),
    );

    expect(writeText).toHaveBeenCalledWith("raw backend error");
    expect(toast.success).toHaveBeenCalledWith("Copied error details.");
  });

  it("retry moves from error state to ready", async () => {
    const user = userEvent.setup();
    vi.mocked(getLayout)
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValue(layout());

    renderHomeView();

    act(() => {
      useHomeWidgetStore.setState({
        loadStatus: "error",
        error: "first failure",
      });
    });
    await user.click(await screen.findByRole("button", { name: "Retry" }));

    await screen.findByText("widget canvas");
    expect(getLayout).toHaveBeenCalledTimes(2);
  });

  it("does not rehydrate chat pins when only widget layout changes", async () => {
    const onHydratePinnedChatSessions = vi.fn();
    vi.mocked(getLayout).mockResolvedValue(
      layout({
        items: [
          {
            id: "00000000-0000-0000-0000-000000000003",
            kind: "session",
            targetId: "session-1",
            centerX: 1094,
            centerY: 540,
            width: 188,
            height: 80,
            zIndex: 2,
            titleOverride: null,
          },
        ],
      }),
    );

    renderHomeViewWithProps({ onHydratePinnedChatSessions });

    await screen.findByText("widget canvas");
    await waitFor(() =>
      expect(onHydratePinnedChatSessions).toHaveBeenCalledWith(["session-1"]),
    );

    act(() => {
      useHomeWidgetStore
        .getState()
        .moveWidget("00000000-0000-0000-0000-000000000003", 1200, 600);
    });
    await waitFor(() => expect(saveLayoutItems).toHaveBeenCalledTimes(1));

    expect(onHydratePinnedChatSessions).toHaveBeenCalledTimes(1);
  });

  it("exposes a top-bar recenter action for the home camera", async () => {
    const user = userEvent.setup();
    vi.mocked(getLayout).mockResolvedValue(
      layout({
        items: [
          {
            id: "00000000-0000-0000-0000-000000000001",
            kind: "clock",
            targetId: "widget:00000000-0000-0000-0000-000000000001",
            centerX: 240,
            centerY: 240,
            width: 240,
            height: 240,
            zIndex: 1,
            titleOverride: null,
          },
          {
            id: "00000000-0000-0000-0000-000000000002",
            kind: "clock",
            targetId: "widget:00000000-0000-0000-0000-000000000002",
            centerX: 640,
            centerY: 360,
            width: 240,
            height: 240,
            zIndex: 2,
            titleOverride: null,
          },
        ],
      }),
    );

    renderHomeViewWithTopBarActions();
    await screen.findByText("widget canvas");

    expect(screen.queryByText("Recenter")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Recenter pinned objects" }),
    );

    expect(useHomeWidgetStore.getState().camera).toEqual({
      centerX: 440,
      centerY: 300,
      zoomBps: 10_000,
    });
  });

  it("keeps the onboarding restart control hidden", async () => {
    vi.mocked(getLayout).mockResolvedValue(layout());
    renderHomeViewWithTopBarActions();
    await screen.findByText("widget canvas");

    expect(
      screen.queryByRole("button", { name: "Reload onboarding tour" }),
    ).not.toBeInTheDocument();
  });

  it("passes the recenter action through to the widget canvas", async () => {
    vi.mocked(getLayout).mockResolvedValue(
      layout({
        items: [
          {
            id: "00000000-0000-0000-0000-000000000001",
            kind: "clock",
            targetId: "widget:00000000-0000-0000-0000-000000000001",
            centerX: 240,
            centerY: 240,
            width: 240,
            height: 240,
            zIndex: 1,
            titleOverride: null,
          },
          {
            id: "00000000-0000-0000-0000-000000000002",
            kind: "clock",
            targetId: "widget:00000000-0000-0000-0000-000000000002",
            centerX: 640,
            centerY: 360,
            width: 240,
            height: 240,
            zIndex: 2,
            titleOverride: null,
          },
        ],
      }),
    );

    renderHomeViewWithProps({ viewportLeftOcclusionPx: 260 });
    await screen.findByText("widget canvas");

    const canvasProps = widgetCanvasMock.mock.calls.at(-1)?.[0];
    if (!canvasProps) {
      throw new Error("WidgetCanvas was not rendered");
    }

    expect(canvasProps.recenterLabel).toBe("Recenter");
    expect(canvasProps.recenterTitle).toBe("Recenter pinned objects");
    expect(canvasProps.recenterTarget).toEqual({ x: 440, y: 300 });
    expect(canvasProps.viewportLeftOcclusionPx).toBe(260);
    expect(canvasProps.onRecenter).toEqual(expect.any(Function));

    await act(async () => {
      canvasProps.onRecenter?.();
      await vi.waitFor(() => expect(saveLayoutCamera).toHaveBeenCalled());
    });

    expect(useHomeWidgetStore.getState().camera).toEqual({
      centerX: 440,
      centerY: 300,
      zoomBps: 10_000,
    });
  });

  it("exposes a top-bar cleanup action that toggles between organized and restored layouts", async () => {
    const user = userEvent.setup();
    vi.mocked(getLayout).mockResolvedValue(
      layout({
        items: [
          {
            id: "00000000-0000-0000-0000-000000000001",
            kind: "persona",
            targetId: "agent-1",
            centerX: 600,
            centerY: 610,
            width: 200,
            height: 220,
            zIndex: 7,
            titleOverride: null,
          },
          {
            id: "00000000-0000-0000-0000-000000000002",
            kind: "clock",
            targetId: "widget:00000000-0000-0000-0000-000000000002",
            centerX: 120,
            centerY: 120,
            width: 240,
            height: 240,
            zIndex: 1,
            titleOverride: null,
          },
          {
            id: "00000000-0000-0000-0000-000000000003",
            kind: "session",
            targetId: "session-1",
            centerX: 1094,
            centerY: 540,
            width: 188,
            height: 80,
            zIndex: 2,
            titleOverride: null,
          },
          {
            id: "00000000-0000-0000-0000-000000000004",
            kind: "skill",
            targetId: "skill-1",
            centerX: 1120,
            centerY: 28,
            width: 240,
            height: 56,
            zIndex: 3,
            titleOverride: null,
          },
        ],
      }),
    );

    renderHomeViewWithTopBarActions();
    await screen.findByText("widget canvas");

    expect(screen.queryByText("Clean up")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clean up pins" }));

    expect(useHomeWidgetStore.getState().instances).toMatchObject([
      { id: "00000000-0000-0000-0000-000000000001", x: 384, y: 0, z: 2 },
      { id: "00000000-0000-0000-0000-000000000002", x: 0, y: 0, z: 1 },
      { id: "00000000-0000-0000-0000-000000000003", x: 744, y: 0, z: 3 },
      { id: "00000000-0000-0000-0000-000000000004", x: 1080, y: 0, z: 4 },
    ]);
    await waitFor(() => expect(saveLayoutItems).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "Revert layout" }));

    expect(useHomeWidgetStore.getState().instances).toMatchObject([
      { id: "00000000-0000-0000-0000-000000000001", x: 500, y: 500, z: 7 },
      { id: "00000000-0000-0000-0000-000000000002", x: 0, y: 0, z: 1 },
      { id: "00000000-0000-0000-0000-000000000003", x: 1000, y: 500, z: 2 },
      { id: "00000000-0000-0000-0000-000000000004", x: 1000, y: 0, z: 3 },
    ]);
    await waitFor(() => expect(saveLayoutItems).toHaveBeenCalledTimes(2));
  });
});
