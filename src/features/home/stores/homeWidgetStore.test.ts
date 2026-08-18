import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { BERDY_ONBOARDING_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { setExperimentEnabled } from "@/features/experiments/experimentPreferences";
import type { Layout, LayoutCamera } from "@/features/layout/api/layout";
import {
  getLayout,
  HOME_LAYOUT_ID,
  saveLayoutCamera,
  saveLayoutItems,
} from "@/features/layout/api/layout";
import { HOME_LAYOUT_REPLACE_KINDS } from "../lib/homeLayoutMapper";
import { loadStarterTaskProgress } from "../onboarding/starterTaskProgress";
import type { WidgetInstance } from "../widgets/types";
import {
  resetHomeWidgetStoreForTests,
  useHomeWidgetStore,
} from "./homeWidgetStore";
import type { HomeWidgetState } from "./homeWidgetRuntime";

type SaveItemsResult = Awaited<ReturnType<typeof saveLayoutItems>>;
type SaveCameraResult = Awaited<ReturnType<typeof saveLayoutCamera>>;
type Deferred<T> = {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
};

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

vi.mock("@/shared/i18n", () => ({
  i18n: {
    t: vi.fn((key: string) => key),
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

const CANVAS_BOUNDS = { width: 1200, height: 800 };
const LEGACY_STORAGE_KEY = "goose-internal:home-widgets";
const CLEAN_UP_SNAPSHOT_STORAGE_KEY = "goose:home:clean-up-snapshot";
const ONBOARDING_STICKIES_SEEDED_STORAGE_KEY =
  "goose:home:onboarding-stickies-seeded";
const BACKEND_CLOCK_ID = "00000000-0000-0000-0000-000000000001";
const SAVED_CLOCK_ID = "00000000-0000-0000-0000-000000000002";
const INITIAL_CAMERA = {
  centerX: 0,
  centerY: 0,
  zoomBps: 10_000,
} satisfies LayoutCamera;
const SAVED_CAMERA = {
  centerX: 120,
  centerY: -48,
  zoomBps: 12_500,
} satisfies LayoutCamera;

function layout(overrides: Partial<Layout> = {}): Layout {
  return {
    layoutId: HOME_LAYOUT_ID,
    itemRevision: 4,
    cameraRevision: 1,
    camera: INITIAL_CAMERA,
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
        id: BACKEND_CLOCK_ID,
        kind: "clock",
        targetId: `widget:${BACKEND_CLOCK_ID}`,
        centerX: 240,
        centerY: 240,
        width: 240,
        height: 240,
        zIndex: 2,
        titleOverride: null,
      },
    ],
    ...overrides,
  };
}

function clockLayoutItem(id: string, centerX: number): Layout["items"][number] {
  return {
    ...layout().items[0],
    id,
    targetId: `widget:${id}`,
    centerX,
    centerY: centerX,
  };
}

function stickyNoteLayoutItem({
  height = 196,
  id,
  noteId,
  width = 224,
  x,
  y,
  zIndex,
}: {
  height?: number;
  id: string;
  noteId: string;
  width?: number;
  x: number;
  y: number;
  zIndex: number;
}): Layout["items"][number] {
  return {
    id,
    kind: "stickyNote",
    targetId: noteId,
    centerX: x + width / 2,
    centerY: y + height / 2,
    width,
    height,
    zIndex,
    titleOverride: null,
  };
}

function clockWidget(overrides: Partial<WidgetInstance> = {}): WidgetInstance {
  return { id: "w1", type: "clock", x: 0, y: 0, z: 1, ...overrides };
}

function setReadyHomeState(overrides: Partial<HomeWidgetState> = {}): void {
  useHomeWidgetStore.setState({
    instances: [clockWidget()],
    itemRevision: 4,
    lastConfirmedLayout: layout(),
    loadStatus: "ready",
    ...overrides,
  });
}

function savedItemsLayout(overrides: Partial<Layout> = {}): Layout {
  return layout({
    camera: INITIAL_CAMERA,
    cameraRevision: 1,
    itemRevision: 5,
    items: [clockLayoutItem(SAVED_CLOCK_ID, 360)],
    ...overrides,
  });
}

function savedCameraLayout(overrides: Partial<Layout> = {}): Layout {
  return layout({
    camera: SAVED_CAMERA,
    cameraRevision: 2,
    ...overrides,
  });
}

function beginOverlappingSaves() {
  const itemSave = deferred<SaveItemsResult>();
  const cameraSave = deferred<SaveCameraResult>();
  const confirmed = layout({ camera: INITIAL_CAMERA, cameraRevision: 1 });
  setReadyHomeState({
    camera: INITIAL_CAMERA,
    cameraRevision: 1,
    constraints: confirmed.constraints,
    lastConfirmedLayout: confirmed,
  });
  vi.mocked(saveLayoutItems).mockReturnValue(itemSave.promise);
  vi.mocked(saveLayoutCamera).mockReturnValue(cameraSave.promise);

  useHomeWidgetStore.getState().moveWidget("w1", 24, 24, CANVAS_BOUNDS);
  useHomeWidgetStore.getState().saveCamera(SAVED_CAMERA);

  return { itemSave, cameraSave };
}

function expectConfirmedSavedCameraAndItem(): void {
  expect(useHomeWidgetStore.getState().lastConfirmedLayout).toMatchObject({
    camera: SAVED_CAMERA,
    cameraRevision: 2,
    itemRevision: 5,
  });
  expect(useHomeWidgetStore.getState().lastConfirmedLayout?.items[0].id).toBe(
    SAVED_CLOCK_ID,
  );
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  resetHomeWidgetStoreForTests();
  vi.mocked(getLayout).mockReset();
  vi.mocked(saveLayoutCamera).mockReset();
  vi.mocked(saveLayoutItems).mockReset();
  vi.mocked(saveLayoutItems).mockImplementation(async (request) => ({
    ok: true,
    layout: layout({ itemRevision: 5, items: request.items }),
  }));
  vi.mocked(saveLayoutCamera).mockImplementation(async (request) => ({
    ok: true,
    layout: layout({ camera: request.camera, cameraRevision: 2 }),
  }));
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.warning).mockClear();
  localStorage.clear();
  localStorage.setItem(ONBOARDING_STICKIES_SEEDED_STORAGE_KEY, "6");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  });
});

describe("homeWidgetStore", () => {
  it("does not confirm starter-agent migration while the legacy Berdy pin remains", async () => {
    const legacyBerdyAgentId = "agent-berdy";
    setReadyHomeState({
      instances: [
        clockWidget(),
        {
          id: "legacy-berdy-pin",
          type: "agentPin",
          x: 0,
          y: 0,
          z: 2,
          state: { agentId: legacyBerdyAgentId },
        },
      ],
    });
    vi.mocked(saveLayoutItems).mockImplementation(async (request) => ({
      ok: true,
      layout: layout({
        itemRevision: 5,
        items: [
          ...request.items,
          {
            id: "legacy-berdy-pin",
            kind: "persona",
            targetId: legacyBerdyAgentId,
            centerX: 100,
            centerY: 100,
            width: 180,
            height: 198,
            zIndex: 2,
            titleOverride: null,
          },
        ],
      }),
    }));

    await expect(
      useHomeWidgetStore
        .getState()
        .addMissingStarterAgentPins(
          ["agent-tinker", "agent-wildcard"],
          legacyBerdyAgentId,
        ),
    ).resolves.toBe(false);
  });

  it("does not apply the starter layout after a user mutation clears eligibility", async () => {
    localStorage.setItem("goose:home:starter-layout-eligible-v1", "1");
    setReadyHomeState();

    useHomeWidgetStore.getState().moveWidget("w1", 20, 30);
    await expect(
      useHomeWidgetStore
        .getState()
        .applyStarterLayout([clockWidget({ x: 522, y: -274 })], INITIAL_CAMERA),
    ).resolves.toBe(false);
    expect(saveLayoutCamera).not.toHaveBeenCalled();
  });

  it("resets starter tasks from a non-Home route and persists the placeholder cube", async () => {
    const existingProject = {
      id: "00000000-0000-0000-0000-000000000099",
      type: "onboardingProjectArtifact",
      x: 20,
      y: 30,
      z: 2,
      width: 400,
      height: 400,
      state: {
        projectId: "real-project",
        onboardingStarterProject: true,
      },
    } satisfies WidgetInstance;
    setReadyHomeState({
      instances: [clockWidget(), existingProject],
      itemRevision: 4,
    });
    vi.mocked(saveLayoutItems).mockImplementation(async (request) => ({
      ok: true,
      layout: layout({ itemRevision: 5, items: request.items }),
    }));

    await expect(
      useHomeWidgetStore.getState().resetStarterTasks(),
    ).resolves.toBe(true);

    expect(useHomeWidgetStore.getState().instances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: existingProject.id,
          type: "onboardingProjectArtifact",
          state: expect.objectContaining({
            projectId: "onboarding-starter-project",
          }),
        }),
        expect.objectContaining({
          type: "stickyNote",
          state: { noteId: "onboarding:starter-tasks" },
        }),
      ]),
    );
  });

  it("rejects widget mutations while a full onboarding reset is in flight", async () => {
    const resetSave = deferred<SaveItemsResult>();
    setReadyHomeState({
      camera: INITIAL_CAMERA,
      cameraRevision: 1,
      itemRevision: 4,
      instances: [clockWidget()],
    });
    vi.mocked(saveLayoutItems).mockReturnValueOnce(resetSave.promise);

    const reset = useHomeWidgetStore.getState().resetHomeForOnboarding();
    useHomeWidgetStore
      .getState()
      .addWidget("agentPin", 10, 10, { agentId: "concurrent" }, CANVAS_BOUNDS);

    expect(
      useHomeWidgetStore
        .getState()
        .instances.some((instance) => instance.state?.agentId === "concurrent"),
    ).toBe(false);

    await waitFor(() => expect(saveLayoutItems).toHaveBeenCalledOnce());
    const requestedItems = vi.mocked(saveLayoutItems).mock.calls[0][0].items;
    resetSave.resolve({
      ok: true,
      layout: layout({ itemRevision: 5, items: requestedItems }),
    });
    await reset;
  });

  it("rejects every persistence entry point while onboarding reset is in flight", async () => {
    const resetSave = deferred<SaveItemsResult>();
    setReadyHomeState({
      camera: INITIAL_CAMERA,
      cameraRevision: 1,
      itemRevision: 4,
      instances: [clockWidget()],
    });
    useHomeWidgetStore.setState({
      cleanUpSnapshot: [{ id: "w1", type: "clock", x: 0, y: 0, z: 1 }],
    });
    vi.mocked(saveLayoutItems).mockReturnValueOnce(resetSave.promise);

    const reset = useHomeWidgetStore.getState().resetHomeForOnboarding();
    await waitFor(() => expect(saveLayoutItems).toHaveBeenCalledOnce());
    const duringReset = useHomeWidgetStore.getState();
    duringReset.addWidget("agentPin", 1, 1, { agentId: "blocked" });
    duringReset.toggleCleanUpWidgets();
    duringReset.saveCamera({ centerX: 99, centerY: 99, zoomBps: 9_999 });
    await expect(
      duringReset.addMissingStarterAgentPins(["blocked"]),
    ).resolves.toBe(false);
    await expect(
      duringReset.applyStarterLayout([clockWidget()], INITIAL_CAMERA),
    ).resolves.toBe(false);

    expect(saveLayoutItems).toHaveBeenCalledOnce();
    expect(saveLayoutCamera).not.toHaveBeenCalled();
    const requestedItems = vi.mocked(saveLayoutItems).mock.calls[0][0].items;
    resetSave.resolve({
      ok: true,
      layout: layout({ itemRevision: 5, items: requestedItems }),
    });
    await reset;
  });

  it("keeps a confirmed onboarding canvas when camera recentering fails", async () => {
    setReadyHomeState({
      camera: INITIAL_CAMERA,
      cameraRevision: 1,
      itemRevision: 4,
    });
    vi.mocked(saveLayoutItems).mockImplementation(async (request) => ({
      ok: true,
      layout: layout({ itemRevision: 5, items: request.items }),
    }));
    vi.mocked(saveLayoutCamera).mockRejectedValue(new Error("camera failed"));

    await expect(
      useHomeWidgetStore.getState().resetHomeForOnboarding(),
    ).resolves.toEqual({ itemsConfirmed: true, cameraConfirmed: false });
    expect(toast.warning).toHaveBeenCalledWith(
      "home:widgetLayer.toasts.cameraSaveFailed",
    );
  });

  it("restores a fresh onboarding tour widget", async () => {
    vi.mocked(saveLayoutItems).mockImplementation(async (request) => ({
      ok: true,
      layout: layout({ itemRevision: 5, items: request.items }),
    }));
    vi.mocked(saveLayoutCamera).mockImplementation(async (request) => ({
      ok: true,
      layout: layout({
        camera: request.camera,
        cameraRevision: 2,
        itemRevision: 5,
      }),
    }));
    setReadyHomeState({
      camera: INITIAL_CAMERA,
      cameraRevision: 1,
      constraints: layout().constraints,
      instances: [
        clockWidget(),
        {
          id: "old-onboarding",
          type: "onboardingTour",
          x: 10,
          y: 20,
          z: 2,
          state: { noteId: "onboarding:tour", welcomeDismissed: true },
        },
      ],
    });

    await expect(
      useHomeWidgetStore.getState().resetOnboardingTour(),
    ).resolves.toBe(true);

    const onboardingWidgets = useHomeWidgetStore
      .getState()
      .instances.filter((instance) => instance.type === "onboardingTour");
    expect(onboardingWidgets).toHaveLength(1);
    expect(onboardingWidgets[0]).toMatchObject({
      x: -146,
      y: 188,
      state: { noteId: "onboarding:tour" },
      z: 2,
    });
    expect(onboardingWidgets[0].state?.welcomeDismissed).toBeUndefined();
    expect(useHomeWidgetStore.getState().camera).toMatchObject({
      centerX: -74,
      centerY: 278,
    });
  });

  it("reports a failed onboarding reset when its widget is not persisted", async () => {
    vi.mocked(saveLayoutItems).mockRejectedValue(new Error("save failed"));
    vi.mocked(saveLayoutCamera).mockImplementation(async (request) => ({
      ok: true,
      layout: layout({ camera: request.camera, cameraRevision: 2 }),
    }));
    setReadyHomeState({
      camera: INITIAL_CAMERA,
      cameraRevision: 1,
      constraints: layout().constraints,
    });

    await expect(
      useHomeWidgetStore.getState().resetOnboardingTour(),
    ).resolves.toBe(false);

    expect(
      useHomeWidgetStore
        .getState()
        .instances.some((instance) => instance.type === "onboardingTour"),
    ).toBe(false);
  });

  it("does not reset onboarding while its experiment is disabled", async () => {
    setExperimentEnabled(BERDY_ONBOARDING_EXPERIMENT_ID, false);
    setReadyHomeState({ instances: [clockWidget()] });

    await expect(
      useHomeWidgetStore.getState().resetOnboardingTour(),
    ).resolves.toBe(false);
    expect(useHomeWidgetStore.getState().instances).toEqual([clockWidget()]);
  });

  it("does not restore Berdy after the user removes it", () => {
    setReadyHomeState({ instances: [clockWidget()] });

    useHomeWidgetStore.getState().syncOnboardingExperiment(true);

    expect(useHomeWidgetStore.getState().instances).toEqual([clockWidget()]);
    expect(saveLayoutItems).not.toHaveBeenCalled();
  });

  it("initializes from backend layout", async () => {
    vi.mocked(getLayout).mockResolvedValue(layout());

    await useHomeWidgetStore.getState().initialize();

    expect(getLayout).toHaveBeenCalledWith(HOME_LAYOUT_ID);
    expect(saveLayoutItems).not.toHaveBeenCalled();
    expect(saveLayoutCamera).not.toHaveBeenCalled();
    expect(useHomeWidgetStore.getState()).toMatchObject({
      loadStatus: "ready",
      itemRevision: 4,
      cameraRevision: 1,
      camera: INITIAL_CAMERA,
      constraints: {
        minCenter: -100_000,
        maxCenter: 100_000,
        minZoomBps: 1_000,
        maxZoomBps: 20_000,
      },
    });
    expect(useHomeWidgetStore.getState().instances).toMatchObject([
      { id: BACKEND_CLOCK_ID, type: "clock", z: 2 },
    ]);
  });

  it("seeds default onboarding widgets when backend returns zero typed items", async () => {
    vi.mocked(getLayout).mockResolvedValue(
      layout({ itemRevision: 7, items: [] }),
    );
    vi.mocked(saveLayoutItems).mockResolvedValue({
      ok: true,
      layout: layout({ itemRevision: 8 }),
    });
    vi.mocked(saveLayoutCamera).mockImplementation(async (request) => ({
      ok: true,
      layout: layout({
        itemRevision: 8,
        cameraRevision: 2,
        camera: request.camera,
      }),
    }));

    await useHomeWidgetStore.getState().initialize();
    await flushMicrotasks();

    expect(saveLayoutItems).toHaveBeenCalledWith(
      expect.objectContaining({
        layoutId: HOME_LAYOUT_ID,
        expectedRevision: 7,
        replaceKinds: HOME_LAYOUT_REPLACE_KINDS,
      }),
    );
    expect(vi.mocked(saveLayoutItems).mock.calls[0][0].items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "clock" }),
        expect.objectContaining({ targetId: "onboarding:tour" }),
        expect.objectContaining({ targetId: "onboarding:starter-project" }),
        expect.objectContaining({ targetId: "onboarding:starter-tasks" }),
      ]),
    );
    expect(saveLayoutCamera).toHaveBeenCalledWith({
      layoutId: HOME_LAYOUT_ID,
      expectedRevision: 1,
      camera: { centerX: 0, centerY: 40, zoomBps: 10_000 },
    });
    expect(useHomeWidgetStore.getState().camera).toEqual({
      centerX: 0,
      centerY: 40,
      zoomBps: 10_000,
    });
    expect(useHomeWidgetStore.getState().loadStatus).toBe("ready");
    expect(useHomeWidgetStore.getState().itemRevision).toBe(8);
    expect(localStorage.getItem("goose:home:starter-layout-eligible-v1")).toBe(
      "1",
    );
    expect(localStorage.getItem("goose:home:starter-layout-v19")).toBeNull();
  });

  it("does not seed or center on Berdy while its experiment is disabled", async () => {
    setExperimentEnabled(BERDY_ONBOARDING_EXPERIMENT_ID, false);
    vi.mocked(getLayout).mockResolvedValue(
      layout({ itemRevision: 7, items: [] }),
    );
    vi.mocked(saveLayoutItems).mockResolvedValue({
      ok: true,
      layout: layout({ itemRevision: 8 }),
    });

    await useHomeWidgetStore.getState().initialize();

    const savedItems = vi.mocked(saveLayoutItems).mock.calls[0][0].items;
    expect(savedItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetId: "onboarding:welcome" }),
      ]),
    );
    expect(savedItems).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetId: "onboarding:tour" }),
      ]),
    );
    expect(saveLayoutCamera).not.toHaveBeenCalled();
    expect(useHomeWidgetStore.getState().camera).toEqual(INITIAL_CAMERA);
  });

  it("backfills onboarding sticky notes into existing layouts once", async () => {
    localStorage.removeItem(ONBOARDING_STICKIES_SEEDED_STORAGE_KEY);

    vi.mocked(getLayout).mockResolvedValue(layout({ itemRevision: 11 }));
    vi.mocked(saveLayoutItems).mockImplementation(async (request) => ({
      ok: true,
      layout: layout({
        itemRevision: 12,
        items: request.items.map((item) => ({
          ...item,
          titleOverride: item.titleOverride ?? null,
        })),
      }),
    }));

    await useHomeWidgetStore.getState().initialize();

    expect(saveLayoutItems).toHaveBeenCalledWith(
      expect.objectContaining({
        layoutId: HOME_LAYOUT_ID,
        expectedRevision: 11,
        replaceKinds: HOME_LAYOUT_REPLACE_KINDS,
      }),
    );
    expect(vi.mocked(saveLayoutItems).mock.calls[0][0].items).toMatchObject([
      { kind: "clock", zIndex: 2 },
      { kind: "stickyNote", targetId: "onboarding:tour", zIndex: 3 },
      { kind: "stickyNote", targetId: "onboarding:start-project", zIndex: 4 },
      { kind: "stickyNote", targetId: "onboarding:build-agent", zIndex: 5 },
      {
        kind: "stickyNote",
        targetId: "onboarding:reuse-workflows",
        zIndex: 6,
      },
      {
        kind: "stickyNote",
        targetId: "onboarding:manage-automations",
        zIndex: 7,
      },
      { kind: "stickyNote", targetId: "onboarding:shape-home", zIndex: 8 },
    ]);
    expect(localStorage.getItem(ONBOARDING_STICKIES_SEEDED_STORAGE_KEY)).toBe(
      "6",
    );
    expect(useHomeWidgetStore.getState()).toMatchObject({
      loadStatus: "ready",
      itemRevision: 12,
    });
    expect(useHomeWidgetStore.getState().instances).toMatchObject([
      { type: "clock" },
      { type: "onboardingTour", state: { noteId: "onboarding:tour" } },
      { type: "stickyNote", state: { noteId: "onboarding:start-project" } },
      { type: "stickyNote", state: { noteId: "onboarding:build-agent" } },
      { type: "stickyNote", state: { noteId: "onboarding:reuse-workflows" } },
      {
        type: "stickyNote",
        state: { noteId: "onboarding:manage-automations" },
      },
      { type: "stickyNote", state: { noteId: "onboarding:shape-home" } },
    ]);
  });

  it("migrates the legacy welcome note to Berdy and snaps untouched onboarding sticky positions without moving customized notes", async () => {
    vi.mocked(getLayout).mockResolvedValue(
      layout({
        itemRevision: 11,
        items: [
          stickyNoteLayoutItem({
            id: "sticky-welcome",
            noteId: "onboarding:welcome",
            x: -360,
            y: -250,
            zIndex: 1,
          }),
          stickyNoteLayoutItem({
            id: "sticky-project",
            noteId: "onboarding:start-project",
            x: -96,
            y: -216,
            zIndex: 2,
          }),
          stickyNoteLayoutItem({
            id: "sticky-build-agent",
            noteId: "onboarding:build-agent",
            x: 168,
            y: -250,
            zIndex: 3,
          }),
          stickyNoteLayoutItem({
            id: "sticky-workflows",
            noteId: "onboarding:reuse-workflows",
            x: -360,
            y: -14,
            zIndex: 4,
          }),
          stickyNoteLayoutItem({
            id: "sticky-automations",
            noteId: "onboarding:manage-automations",
            x: -96,
            y: -14,
            zIndex: 5,
          }),
          stickyNoteLayoutItem({
            id: "sticky-home",
            noteId: "onboarding:shape-home",
            x: 168,
            y: -14,
            zIndex: 6,
          }),
        ],
      }),
    );
    vi.mocked(saveLayoutItems).mockImplementation(async (request) => ({
      ok: true,
      layout: layout({
        itemRevision: 12,
        items: request.items.map((item) => ({
          ...item,
          titleOverride: item.titleOverride ?? null,
        })),
      }),
    }));

    await useHomeWidgetStore.getState().initialize();

    expect(saveLayoutItems).toHaveBeenCalledWith(
      expect.objectContaining({
        layoutId: HOME_LAYOUT_ID,
        expectedRevision: 11,
        replaceKinds: HOME_LAYOUT_REPLACE_KINDS,
      }),
    );
    expect(vi.mocked(saveLayoutItems).mock.calls[0][0].items).toMatchObject([
      {
        targetId: "onboarding:start-project",
        centerX: 16,
        centerY: -118,
      },
      {
        targetId: "onboarding:build-agent",
        centerX: 280,
        centerY: -142,
      },
      {
        targetId: "onboarding:reuse-workflows",
        centerX: -248,
        centerY: 98,
      },
      {
        targetId: "onboarding:manage-automations",
        centerX: 16,
        centerY: 98,
      },
      {
        targetId: "onboarding:shape-home",
        centerX: 280,
        centerY: 98,
      },
      {
        targetId: "onboarding:tour",
        centerX: 894,
        centerY: 326,
      },
    ]);
    expect(useHomeWidgetStore.getState()).toMatchObject({
      loadStatus: "ready",
      itemRevision: 12,
    });
  });

  it("preserves a customized legacy welcome note", async () => {
    const customizedWelcome = {
      ...stickyNoteLayoutItem({
        id: "sticky-welcome",
        noteId: "onboarding:welcome",
        x: -360,
        y: -250,
        zIndex: 1,
      }),
      widgetState: { text: "Keep this note" },
    };
    vi.mocked(getLayout).mockResolvedValue(
      layout({ itemRevision: 11, items: [customizedWelcome] }),
    );

    await useHomeWidgetStore.getState().initialize();

    expect(saveLayoutItems).not.toHaveBeenCalled();
    expect(useHomeWidgetStore.getState().instances).toMatchObject([
      {
        id: "sticky-welcome",
        type: "stickyNote",
        state: {
          noteId: "onboarding:welcome",
          text: "Keep this note",
        },
      },
    ]);
  });

  it("upgrades old two-note onboarding layouts with the new primitive notes", async () => {
    localStorage.setItem(ONBOARDING_STICKIES_SEEDED_STORAGE_KEY, "2");

    vi.mocked(getLayout).mockResolvedValue(
      layout({
        itemRevision: 11,
        items: [
          {
            id: "clock-1",
            kind: "clock",
            targetId: "widget:clock-1",
            centerX: 240,
            centerY: 240,
            width: 200,
            height: 200,
            zIndex: 1,
            titleOverride: null,
          },
          {
            id: "sticky-build-agent",
            kind: "stickyNote",
            targetId: "onboarding:build-agent",
            centerX: 0,
            centerY: 0,
            width: 224,
            height: 196,
            zIndex: 2,
            titleOverride: null,
          },
          {
            id: "sticky-start-project",
            kind: "stickyNote",
            targetId: "onboarding:start-project",
            centerX: 260,
            centerY: 0,
            width: 224,
            height: 196,
            zIndex: 3,
            titleOverride: null,
          },
        ],
      }),
    );
    vi.mocked(saveLayoutItems).mockImplementation(async (request) => ({
      ok: true,
      layout: layout({
        itemRevision: 12,
        items: request.items.map((item) => ({
          ...item,
          titleOverride: item.titleOverride ?? null,
        })),
      }),
    }));

    await useHomeWidgetStore.getState().initialize();

    expect(saveLayoutItems).toHaveBeenCalledWith(
      expect.objectContaining({
        layoutId: HOME_LAYOUT_ID,
        expectedRevision: 11,
        replaceKinds: HOME_LAYOUT_REPLACE_KINDS,
      }),
    );
    expect(vi.mocked(saveLayoutItems).mock.calls[0][0].items).toMatchObject([
      { kind: "clock", zIndex: 1 },
      { kind: "stickyNote", targetId: "onboarding:build-agent", zIndex: 2 },
      { kind: "stickyNote", targetId: "onboarding:start-project", zIndex: 3 },
      { kind: "stickyNote", targetId: "onboarding:tour", zIndex: 4 },
      {
        kind: "stickyNote",
        targetId: "onboarding:reuse-workflows",
        zIndex: 5,
      },
      {
        kind: "stickyNote",
        targetId: "onboarding:manage-automations",
        zIndex: 6,
      },
      { kind: "stickyNote", targetId: "onboarding:shape-home", zIndex: 7 },
    ]);
    expect(localStorage.getItem(ONBOARDING_STICKIES_SEEDED_STORAGE_KEY)).toBe(
      "6",
    );
  });

  it("adds automations and the onboarding tour to layouts that already got the skills and home notes", async () => {
    localStorage.setItem(ONBOARDING_STICKIES_SEEDED_STORAGE_KEY, "3");

    vi.mocked(getLayout).mockResolvedValue(
      layout({
        itemRevision: 11,
        items: [
          {
            id: "sticky-build-agent",
            kind: "stickyNote",
            targetId: "onboarding:build-agent",
            centerX: 0,
            centerY: 0,
            width: 224,
            height: 196,
            zIndex: 1,
            titleOverride: null,
          },
          {
            id: "sticky-skills",
            kind: "stickyNote",
            targetId: "onboarding:reuse-workflows",
            centerX: 0,
            centerY: 240,
            width: 224,
            height: 196,
            zIndex: 2,
            titleOverride: null,
          },
          {
            id: "sticky-home",
            kind: "stickyNote",
            targetId: "onboarding:shape-home",
            centerX: 260,
            centerY: 240,
            width: 224,
            height: 196,
            zIndex: 3,
            titleOverride: null,
          },
        ],
      }),
    );
    vi.mocked(saveLayoutItems).mockImplementation(async (request) => ({
      ok: true,
      layout: layout({
        itemRevision: 12,
        items: request.items.map((item) => ({
          ...item,
          titleOverride: item.titleOverride ?? null,
        })),
      }),
    }));

    await useHomeWidgetStore.getState().initialize();

    expect(vi.mocked(saveLayoutItems).mock.calls[0][0].items).toMatchObject([
      { kind: "stickyNote", targetId: "onboarding:build-agent", zIndex: 1 },
      {
        kind: "stickyNote",
        targetId: "onboarding:reuse-workflows",
        zIndex: 2,
      },
      { kind: "stickyNote", targetId: "onboarding:shape-home", zIndex: 3 },
      { kind: "stickyNote", targetId: "onboarding:tour", zIndex: 4 },
      {
        kind: "stickyNote",
        targetId: "onboarding:manage-automations",
        zIndex: 5,
      },
    ]);
    expect(localStorage.getItem(ONBOARDING_STICKIES_SEEDED_STORAGE_KEY)).toBe(
      "6",
    );
  });

  it("adds only the onboarding tour to layouts that already got the full v5 set", async () => {
    localStorage.setItem(ONBOARDING_STICKIES_SEEDED_STORAGE_KEY, "5");

    vi.mocked(getLayout).mockResolvedValue(
      layout({
        itemRevision: 11,
        items: [
          {
            id: "sticky-build-agent",
            kind: "stickyNote",
            targetId: "onboarding:build-agent",
            centerX: 0,
            centerY: 0,
            width: 224,
            height: 196,
            zIndex: 1,
            titleOverride: null,
          },
          {
            id: "sticky-project",
            kind: "stickyNote",
            targetId: "onboarding:start-project",
            centerX: 260,
            centerY: 0,
            width: 224,
            height: 196,
            zIndex: 2,
            titleOverride: null,
          },
          {
            id: "sticky-skills",
            kind: "stickyNote",
            targetId: "onboarding:reuse-workflows",
            centerX: 0,
            centerY: 240,
            width: 224,
            height: 196,
            zIndex: 3,
            titleOverride: null,
          },
          {
            id: "sticky-automations",
            kind: "stickyNote",
            targetId: "onboarding:manage-automations",
            centerX: 260,
            centerY: 240,
            width: 224,
            height: 196,
            zIndex: 4,
            titleOverride: null,
          },
          {
            id: "sticky-home",
            kind: "stickyNote",
            targetId: "onboarding:shape-home",
            centerX: 520,
            centerY: 240,
            width: 224,
            height: 196,
            zIndex: 5,
            titleOverride: null,
          },
        ],
      }),
    );
    vi.mocked(saveLayoutItems).mockImplementation(async (request) => ({
      ok: true,
      layout: layout({
        itemRevision: 12,
        items: request.items.map((item) => ({
          ...item,
          titleOverride: item.titleOverride ?? null,
        })),
      }),
    }));

    await useHomeWidgetStore.getState().initialize();

    expect(vi.mocked(saveLayoutItems).mock.calls[0][0].items).toMatchObject([
      { kind: "stickyNote", targetId: "onboarding:build-agent", zIndex: 1 },
      { kind: "stickyNote", targetId: "onboarding:start-project", zIndex: 2 },
      {
        kind: "stickyNote",
        targetId: "onboarding:reuse-workflows",
        zIndex: 3,
      },
      {
        kind: "stickyNote",
        targetId: "onboarding:manage-automations",
        zIndex: 4,
      },
      { kind: "stickyNote", targetId: "onboarding:shape-home", zIndex: 5 },
      { kind: "stickyNote", targetId: "onboarding:tour", zIndex: 6 },
    ]);
    expect(localStorage.getItem(ONBOARDING_STICKIES_SEEDED_STORAGE_KEY)).toBe(
      "6",
    );
  });

  it("does not backfill onboarding sticky notes after they were offered", async () => {
    // If the user unpinned the onboarding notes, that choice must be respected
    // across reloads. The one-time local marker prevents re-adding them.
    const agentPinItem: Layout["items"][number] = {
      id: "agent-1",
      kind: "persona",
      targetId: "persona-1",
      centerX: 240,
      centerY: 240,
      width: 200,
      height: 220,
      zIndex: 1,
      titleOverride: null,
    };
    vi.mocked(getLayout).mockResolvedValue(
      layout({ itemRevision: 11, items: [agentPinItem] }),
    );

    await useHomeWidgetStore.getState().initialize();

    expect(saveLayoutItems).not.toHaveBeenCalled();
    expect(useHomeWidgetStore.getState()).toMatchObject({
      loadStatus: "ready",
      itemRevision: 11,
    });
    expect(useHomeWidgetStore.getState().instances).toHaveLength(1);
    expect(useHomeWidgetStore.getState().instances[0].type).toBe("agentPin");
  });

  it("adopts the backend layout when default widget seeding conflicts", async () => {
    const conflict = layout({ itemRevision: 9 });
    vi.mocked(getLayout).mockResolvedValue(
      layout({ itemRevision: 7, items: [] }),
    );
    vi.mocked(saveLayoutItems).mockResolvedValue({
      ok: false,
      reason: "revisionConflict",
      layout: conflict,
    });

    await useHomeWidgetStore.getState().initialize();

    expect(useHomeWidgetStore.getState()).toMatchObject({
      loadStatus: "ready",
      itemRevision: 9,
    });
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("uses uuids for generated default widget ids", async () => {
    vi.mocked(getLayout).mockResolvedValue(layout({ items: [] }));
    vi.mocked(saveLayoutItems).mockResolvedValue({
      ok: true,
      layout: layout(),
    });

    await useHomeWidgetStore.getState().initialize();

    const request = vi.mocked(saveLayoutItems).mock.calls[0][0];
    for (const item of request.items) {
      expect(item.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(item.id).not.toBe("default-clock");
    }
  });

  it("ignores stale localStorage data and leaves it untouched", async () => {
    localStorage.setItem(LEGACY_STORAGE_KEY, "stale payload");
    vi.mocked(getLayout).mockResolvedValue(layout());

    await useHomeWidgetStore.getState().initialize();

    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBe("stale payload");
    expect(useHomeWidgetStore.getState().instances[0].id).toBe(
      BACKEND_CLOCK_ID,
    );
  });

  it("retries startup failures three times and exposes the raw error", async () => {
    vi.mocked(getLayout).mockRejectedValue("backend offline");

    await useHomeWidgetStore.getState().initialize();

    expect(getLayout).toHaveBeenCalledTimes(3);
    expect(useHomeWidgetStore.getState()).toMatchObject({
      loadStatus: "error",
      error: "backend offline",
    });
  });

  it("preserves structured error details for load error copy", async () => {
    const rootCause = new Error("root cause");
    const loadError = new Error("backend offline");
    loadError.stack = "Error: backend offline\n    at test";
    (loadError as Error & { cause?: unknown }).cause = rootCause;
    vi.mocked(getLayout).mockRejectedValue(loadError);

    await useHomeWidgetStore.getState().initialize();

    const error = useHomeWidgetStore.getState().error;
    expect(error).toContain("name: Error");
    expect(error).toContain("message: backend offline");
    expect(error).toContain("stack: Error: backend offline");
    expect(error).toContain("cause: name: Error");
    expect(error).toContain("message: root cause");
  });

  it("retry starts a fresh three-attempt initialization sequence", async () => {
    vi.mocked(getLayout).mockRejectedValue("still offline");

    await useHomeWidgetStore.getState().initialize();
    await useHomeWidgetStore.getState().retryInitialize();

    expect(getLayout).toHaveBeenCalledTimes(6);
  });

  it("initialize does not reload when already ready with a revision", async () => {
    vi.mocked(getLayout).mockResolvedValue(layout());

    await useHomeWidgetStore.getState().initialize();
    await useHomeWidgetStore.getState().initialize();

    expect(getLayout).toHaveBeenCalledTimes(1);
    expect(useHomeWidgetStore.getState().loadStatus).toBe("ready");
  });

  it("retry only forces a fresh initialization from error state", async () => {
    vi.mocked(getLayout).mockResolvedValue(layout());

    await useHomeWidgetStore.getState().initialize();
    await useHomeWidgetStore.getState().retryInitialize();

    expect(getLayout).toHaveBeenCalledTimes(1);
  });

  it("ignores stale in-flight initialize results after reset and fresh initialize", async () => {
    const staleLoad = deferred<Layout>();
    const staleLayout = layout({ itemRevision: 6 });
    const freshLayout = layout({ itemRevision: 12 });
    vi.mocked(getLayout)
      .mockReturnValueOnce(staleLoad.promise)
      .mockResolvedValue(freshLayout);

    const staleInitialize = useHomeWidgetStore.getState().initialize();
    resetHomeWidgetStoreForTests();
    localStorage.setItem(ONBOARDING_STICKIES_SEEDED_STORAGE_KEY, "6");
    await useHomeWidgetStore.getState().initialize();

    staleLoad.resolve(staleLayout);
    await staleInitialize;
    await flushMicrotasks();

    expect(useHomeWidgetStore.getState()).toMatchObject({
      loadStatus: "ready",
      itemRevision: 12,
    });
  });

  it("dedupes concurrent initialize calls", async () => {
    const pending = deferred<Layout>();
    vi.mocked(getLayout).mockReturnValue(pending.promise);

    const first = useHomeWidgetStore.getState().initialize();
    const second = useHomeWidgetStore.getState().initialize();
    pending.resolve(layout());
    await Promise.all([first, second]);

    expect(getLayout).toHaveBeenCalledTimes(1);
  });

  it("copy details shows localized success and failure toasts", async () => {
    const writeText = vi.fn().mockResolvedValueOnce(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    useHomeWidgetStore.setState({ error: "raw backend error" });

    await useHomeWidgetStore.getState().copyErrorDetails();

    expect(writeText).toHaveBeenCalledWith("raw backend error");
    expect(toast.success).toHaveBeenCalledWith(
      "home:widgetLayer.toasts.copySuccess",
    );

    writeText.mockRejectedValueOnce(new Error("denied"));
    await useHomeWidgetStore.getState().copyErrorDetails();

    expect(toast.error).toHaveBeenCalledWith(
      "home:widgetLayer.toasts.copyFailed",
    );
  });

  it("completes the widget task only after the widget save is confirmed", async () => {
    const pendingSave = deferred<SaveItemsResult>();
    setReadyHomeState({
      instances: [clockWidget({ id: BACKEND_CLOCK_ID, x: 120, y: 120 })],
    });
    vi.mocked(saveLayoutItems).mockReturnValue(pendingSave.promise);

    useHomeWidgetStore
      .getState()
      .addWidget("agentPin", 240, 240, { agentId: "a1" }, CANVAS_BOUNDS);

    expect(loadStarterTaskProgress().completion["add-widget"]).toBe(false);

    pendingSave.resolve({
      ok: true,
      layout: layout({
        itemRevision: 5,
        items: vi.mocked(saveLayoutItems).mock.calls[0][0].items,
      }),
    });
    await flushMicrotasks();

    expect(loadStarterTaskProgress().completion["add-widget"]).toBe(true);
  });

  it("does not complete the widget task when the widget save fails", async () => {
    setReadyHomeState({
      instances: [clockWidget({ id: BACKEND_CLOCK_ID, x: 120, y: 120 })],
    });
    vi.mocked(saveLayoutItems).mockRejectedValue(new Error("save failed"));

    useHomeWidgetStore
      .getState()
      .addWidget("agentPin", 240, 240, { agentId: "a1" }, CANVAS_BOUNDS);
    await flushMicrotasks();

    expect(loadStarterTaskProgress().completion["add-widget"]).toBe(false);
  });

  it("optimistically updates actions and saves with revision and replace kinds", async () => {
    const pendingSave = deferred<SaveItemsResult>();
    setReadyHomeState({
      instances: [clockWidget({ id: BACKEND_CLOCK_ID, x: 120, y: 120 })],
    });
    vi.mocked(saveLayoutItems).mockReturnValue(pendingSave.promise);

    useHomeWidgetStore
      .getState()
      .addWidget("agentPin", 240, 240, { agentId: "a1" }, CANVAS_BOUNDS);
    expect(useHomeWidgetStore.getState().instances.at(-1)).toMatchObject({
      type: "agentPin",
      state: { agentId: "a1" },
    });
    expect(saveLayoutItems).toHaveBeenCalledWith(
      expect.objectContaining({
        layoutId: HOME_LAYOUT_ID,
        expectedRevision: 4,
        replaceKinds: HOME_LAYOUT_REPLACE_KINDS,
      }),
    );

    const added = useHomeWidgetStore.getState().instances.at(-1);
    if (!added) throw new Error("expected added widget");

    useHomeWidgetStore.getState().moveWidget(added.id, 13, 13, CANVAS_BOUNDS);
    useHomeWidgetStore.getState().bumpZ(added.id);
    useHomeWidgetStore.getState().updateWidgetState(added.id, { extra: true });
    expect(
      useHomeWidgetStore
        .getState()
        .instances.find((instance) => instance.id === added.id),
    ).toMatchObject({
      x: 24,
      y: 24,
      state: { agentId: "a1", extra: true },
    });
    useHomeWidgetStore.getState().removeWidget(added.id);

    expect(
      useHomeWidgetStore
        .getState()
        .instances.find((instance) => instance.id === added.id),
    ).toBeUndefined();

    pendingSave.resolve({ ok: true, layout: layout({ itemRevision: 5 }) });
    await flushMicrotasks();
  });

  it("adds widgets into the organized layout while preserving the restore snapshot", async () => {
    setReadyHomeState({
      instances: [
        clockWidget({
          id: BACKEND_CLOCK_ID,
          x: 0,
          y: 0,
          z: 1,
          width: 240,
          height: 240,
        }),
      ],
    });
    useHomeWidgetStore.setState({
      cleanUpSnapshot: [
        {
          id: BACKEND_CLOCK_ID,
          type: "clock",
          x: 240,
          y: 240,
          z: 3,
          width: 300,
          height: 300,
        },
      ],
    });
    vi.mocked(saveLayoutItems).mockImplementation(async (request) => ({
      ok: true,
      layout: layout({ items: request.items, itemRevision: 5 }),
    }));

    useHomeWidgetStore
      .getState()
      .addWidget("agentPin", 500, 500, { agentId: "a1" }, CANVAS_BOUNDS);

    const added = useHomeWidgetStore
      .getState()
      .instances.find((instance) => instance.type === "agentPin");
    expect(added).toMatchObject({
      x: 384,
      y: 0,
      z: 2,
      width: 200,
      height: 220,
      state: { agentId: "a1" },
    });
    expect(useHomeWidgetStore.getState().cleanUpSnapshot).toEqual([
      {
        id: BACKEND_CLOCK_ID,
        type: "clock",
        x: 240,
        y: 240,
        z: 3,
        width: 300,
        height: 300,
      },
      expect.objectContaining({
        id: added?.id,
        type: "agentPin",
        x: 408,
        y: 384,
        z: 2,
        width: 200,
        height: 220,
      }),
    ]);
    await flushMicrotasks();
    expect(saveLayoutItems).toHaveBeenCalledTimes(1);

    useHomeWidgetStore.getState().toggleCleanUpWidgets(CANVAS_BOUNDS);

    expect(useHomeWidgetStore.getState().instances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: BACKEND_CLOCK_ID,
          x: 240,
          y: 240,
          z: 3,
          width: 300,
          height: 300,
        }),
        expect.objectContaining({
          id: added?.id,
          type: "agentPin",
          x: 408,
          y: 384,
          z: 2,
          width: 200,
          height: 220,
          state: { agentId: "a1" },
        }),
      ]),
    );
  });

  it("restores the previous cleanup snapshot when organized add save fails", async () => {
    const previousSnapshot = [
      {
        id: BACKEND_CLOCK_ID,
        type: "clock",
        x: 240,
        y: 240,
        z: 3,
        width: 300,
        height: 300,
      },
    ];
    setReadyHomeState({
      instances: [
        clockWidget({
          id: BACKEND_CLOCK_ID,
          x: 0,
          y: 0,
          z: 1,
          width: 240,
          height: 240,
        }),
      ],
    });
    useHomeWidgetStore.setState({ cleanUpSnapshot: previousSnapshot });
    localStorage.setItem(
      CLEAN_UP_SNAPSHOT_STORAGE_KEY,
      JSON.stringify(previousSnapshot),
    );
    vi.mocked(saveLayoutItems).mockRejectedValue("write failed");

    useHomeWidgetStore
      .getState()
      .addWidget("agentPin", 500, 500, { agentId: "a1" }, CANVAS_BOUNDS);
    expect(useHomeWidgetStore.getState().cleanUpSnapshot).toHaveLength(2);

    await flushMicrotasks();

    expect(useHomeWidgetStore.getState().cleanUpSnapshot).toEqual(
      previousSnapshot,
    );
    expect(localStorage.getItem(CLEAN_UP_SNAPSHOT_STORAGE_KEY)).toBe(
      JSON.stringify(previousSnapshot),
    );
  });

  it("does not mutate or save before a backend layout is ready", () => {
    useHomeWidgetStore.setState({
      instances: [{ id: "w1", type: "clock", x: 0, y: 0, z: 1 }],
      loadStatus: "loading",
      itemRevision: null,
    });

    useHomeWidgetStore
      .getState()
      .addWidget("agentPin", 240, 240, { agentId: "a1" }, CANVAS_BOUNDS);
    useHomeWidgetStore.getState().moveWidget("w1", 24, 24, CANVAS_BOUNDS);
    useHomeWidgetStore.getState().bumpZ("w1");
    useHomeWidgetStore.getState().updateWidgetState("w1", { extra: true });
    useHomeWidgetStore.getState().removeWidget("w1");
    useHomeWidgetStore
      .getState()
      .saveCamera({ centerX: 100, centerY: 100, zoomBps: 12_000 });

    expect(useHomeWidgetStore.getState().instances).toEqual([
      { id: "w1", type: "clock", x: 0, y: 0, z: 1 },
    ]);
    expect(saveLayoutItems).not.toHaveBeenCalled();
    expect(saveLayoutCamera).not.toHaveBeenCalled();
  });

  it("optimistically saves camera with its own revision", async () => {
    const pendingSave = deferred<SaveCameraResult>();
    setReadyHomeState({
      camera: INITIAL_CAMERA,
      cameraRevision: 3,
      constraints: layout().constraints,
    });
    vi.mocked(saveLayoutCamera).mockReturnValue(pendingSave.promise);

    useHomeWidgetStore.getState().saveCamera(SAVED_CAMERA);

    expect(useHomeWidgetStore.getState()).toMatchObject({
      camera: SAVED_CAMERA,
      cameraSaveStatus: "saving",
    });
    expect(saveLayoutCamera).toHaveBeenCalledWith({
      layoutId: HOME_LAYOUT_ID,
      expectedRevision: 3,
      camera: SAVED_CAMERA,
    });

    pendingSave.resolve({
      ok: true,
      layout: layout({
        cameraRevision: 4,
        camera: SAVED_CAMERA,
      }),
    });
    await flushMicrotasks();

    expect(useHomeWidgetStore.getState()).toMatchObject({
      cameraRevision: 4,
      cameraSaveStatus: "idle",
      camera: SAVED_CAMERA,
    });
  });

  it("adopts camera conflict layout without overwriting local item edits", async () => {
    setReadyHomeState({
      instances: [clockWidget({ id: "local" })],
      camera: INITIAL_CAMERA,
      cameraRevision: 3,
      constraints: layout().constraints,
    });
    vi.mocked(saveLayoutCamera).mockResolvedValue({
      ok: false,
      reason: "revisionConflict",
      layout: layout({
        cameraRevision: 6,
        camera: { centerX: 500, centerY: 600, zoomBps: 8_000 },
      }),
    });

    useHomeWidgetStore.getState().saveCamera(SAVED_CAMERA);
    await flushMicrotasks();

    expect(useHomeWidgetStore.getState()).toMatchObject({
      cameraRevision: 6,
      camera: { centerX: 500, centerY: 600, zoomBps: 8_000 },
      instances: [{ id: "local", type: "clock", x: 0, y: 0, z: 1 }],
    });
    expect(toast.warning).toHaveBeenCalledWith(
      "home:widgetLayer.toasts.conflict",
    );
  });

  it("preserves newer camera after a stale item save response", async () => {
    const { itemSave, cameraSave } = beginOverlappingSaves();

    cameraSave.resolve({
      ok: true,
      layout: savedCameraLayout(),
    });
    await flushMicrotasks();

    itemSave.resolve({
      ok: true,
      layout: savedItemsLayout(),
    });
    await flushMicrotasks();

    expect(useHomeWidgetStore.getState()).toMatchObject({
      camera: SAVED_CAMERA,
      cameraRevision: 2,
      itemRevision: 5,
    });
    expectConfirmedSavedCameraAndItem();
  });

  it("merges camera save responses into the confirmed item snapshot", async () => {
    const { itemSave, cameraSave } = beginOverlappingSaves();

    itemSave.resolve({
      ok: true,
      layout: savedItemsLayout(),
    });
    await flushMicrotasks();

    cameraSave.resolve({
      ok: true,
      layout: savedCameraLayout({ itemRevision: 4 }),
    });
    await flushMicrotasks();

    expectConfirmedSavedCameraAndItem();
  });

  it.each([
    "conflict",
    "error",
  ] as const)("preserves current camera after item save %s while camera save is pending", async (mode) => {
    const { itemSave, cameraSave } = beginOverlappingSaves();

    if (mode === "conflict") {
      itemSave.resolve({
        ok: false,
        reason: "revisionConflict",
        layout: savedItemsLayout({ itemRevision: 6, items: layout().items }),
      });
    } else {
      itemSave.reject("write failed");
    }
    await flushMicrotasks();

    expect(useHomeWidgetStore.getState()).toMatchObject({
      camera: SAVED_CAMERA,
      cameraRevision: 1,
      cameraSaveStatus: "saving",
    });
    expect(useHomeWidgetStore.getState().lastConfirmedLayout?.camera).toEqual(
      SAVED_CAMERA,
    );

    cameraSave.resolve({
      ok: true,
      layout: savedCameraLayout(),
    });
    await flushMicrotasks();
  });

  it("normalizes z order while bumping the target widget to the top", () => {
    vi.mocked(saveLayoutItems).mockResolvedValue({
      ok: true,
      layout: layout({ itemRevision: 5 }),
    });
    setReadyHomeState({
      instances: [
        { id: "a", type: "clock", x: 0, y: 0, z: 500 },
        { id: "b", type: "clock", x: 0, y: 0, z: 20 },
        { id: "c", type: "clock", x: 0, y: 0, z: 1200 },
      ],
    });

    useHomeWidgetStore.getState().bumpZ("b");

    expect(useHomeWidgetStore.getState().instances).toMatchObject([
      { id: "a", z: 1 },
      { id: "b", z: 3 },
      { id: "c", z: 2 },
    ]);
  });

  it.each([
    [
      "moving a missing widget",
      () =>
        useHomeWidgetStore
          .getState()
          .moveWidget("missing", 48, 48, CANVAS_BOUNDS),
    ],
    [
      "moving to the same snapped and clamped position",
      () =>
        useHomeWidgetStore.getState().moveWidget("w1", 13, 13, CANVAS_BOUNDS),
    ],
    [
      "bumping z for a missing widget",
      () => useHomeWidgetStore.getState().bumpZ("missing"),
    ],
    [
      "removing a missing widget",
      () => useHomeWidgetStore.getState().removeWidget("missing"),
    ],
    [
      "updating state for a missing widget",
      () =>
        useHomeWidgetStore
          .getState()
          .updateWidgetState("missing", { mode: "remote" }),
    ],
    [
      "updating state with a shallow-equal merge",
      () =>
        useHomeWidgetStore
          .getState()
          .updateWidgetState("w1", { mode: "local" }),
    ],
  ])("does not mutate or save when %s", (_, act) => {
    setReadyHomeState({
      instances: [clockWidget({ x: 24, y: 24, state: { mode: "local" } })],
    });
    const before = useHomeWidgetStore.getState().instances;

    act();

    expect(useHomeWidgetStore.getState().instances).toBe(before);
    expect(saveLayoutItems).not.toHaveBeenCalled();
  });

  it("coalesces queued mutations while a save is in flight", async () => {
    const firstSave = deferred<SaveItemsResult>();
    vi.mocked(saveLayoutItems)
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValue({
        ok: true,
        layout: layout({ itemRevision: 6 }),
      });
    setReadyHomeState();

    useHomeWidgetStore.getState().moveWidget("w1", 24, 24, CANVAS_BOUNDS);
    useHomeWidgetStore.getState().moveWidget("w1", 48, 48, CANVAS_BOUNDS);
    useHomeWidgetStore.getState().bumpZ("w1");

    expect(saveLayoutItems).toHaveBeenCalledTimes(1);
    firstSave.resolve({ ok: true, layout: layout({ itemRevision: 5 }) });
    await flushMicrotasks();

    expect(saveLayoutItems).toHaveBeenCalledTimes(2);
    const secondRequest = vi.mocked(saveLayoutItems).mock.calls[1][0];
    expect(secondRequest.expectedRevision).toBe(5);
    expect(secondRequest.items[0]).toMatchObject({
      centerX: 126,
      centerY: 126,
      zIndex: 1,
    });
    expect(secondRequest.items).toHaveLength(1);
  });

  it("adopts returned backend layout after a successful save", async () => {
    setReadyHomeState();
    vi.mocked(saveLayoutItems).mockResolvedValue({
      ok: true,
      layout: layout({ itemRevision: 9 }),
    });

    useHomeWidgetStore.getState().moveWidget("w1", 24, 24, CANVAS_BOUNDS);
    await flushMicrotasks();

    expect(useHomeWidgetStore.getState().itemRevision).toBe(9);
    expect(useHomeWidgetStore.getState().instances[0].id).toBe(
      BACKEND_CLOCK_ID,
    );
  });

  it("adopts conflict layout and drops queued local changes", async () => {
    const conflict = layout({ itemRevision: 11 });
    setReadyHomeState();
    vi.mocked(saveLayoutItems).mockResolvedValue({
      ok: false,
      reason: "revisionConflict",
      layout: conflict,
    });

    useHomeWidgetStore.getState().moveWidget("w1", 24, 24, CANVAS_BOUNDS);
    await flushMicrotasks();

    expect(useHomeWidgetStore.getState().itemRevision).toBe(11);
    expect(toast.warning).toHaveBeenCalledWith(
      "home:widgetLayer.toasts.conflict",
    );
    expect(useHomeWidgetStore.getState().instances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: BACKEND_CLOCK_ID,
        }),
      ]),
    );
  });

  it("clears cleanup snapshot when a cleanup save conflicts", async () => {
    const conflict = layout({ itemRevision: 11 });
    setReadyHomeState({
      instances: [
        clockWidget({ id: BACKEND_CLOCK_ID, x: 48, y: 72, z: 5, width: 300 }),
      ],
    });
    vi.mocked(saveLayoutItems).mockResolvedValue({
      ok: false,
      reason: "revisionConflict",
      layout: conflict,
    });

    useHomeWidgetStore.getState().toggleCleanUpWidgets(CANVAS_BOUNDS);
    expect(useHomeWidgetStore.getState().cleanUpSnapshot).not.toBeNull();
    await flushMicrotasks();

    expect(useHomeWidgetStore.getState().cleanUpSnapshot).toBeNull();
    expect(localStorage.getItem(CLEAN_UP_SNAPSHOT_STORAGE_KEY)).toBeNull();
  });

  it("retries newly added widgets on top of the latest layout after a conflict", async () => {
    const conflict = layout({
      itemRevision: 11,
      items: [clockLayoutItem(SAVED_CLOCK_ID, 360)],
    });
    const saved = layout({
      itemRevision: 12,
      items: [
        clockLayoutItem(SAVED_CLOCK_ID, 360),
        {
          id: "agent-pin-1",
          kind: "persona",
          targetId: "agent-1",
          centerX: 500,
          centerY: 500,
          width: 200,
          height: 220,
          zIndex: 3,
          titleOverride: null,
        },
      ],
    });
    setReadyHomeState();
    vi.mocked(saveLayoutItems)
      .mockResolvedValueOnce({
        ok: false,
        reason: "revisionConflict",
        layout: conflict,
      })
      .mockResolvedValueOnce({
        ok: true,
        layout: saved,
      });

    useHomeWidgetStore
      .getState()
      .addWidget("agentPin", 500, 500, { agentId: "agent-1" }, CANVAS_BOUNDS);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(saveLayoutItems).toHaveBeenCalledTimes(2);
    const retryRequest = vi.mocked(saveLayoutItems).mock.calls[1][0];
    expect(retryRequest.expectedRevision).toBe(11);
    expect(retryRequest.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "persona",
          targetId: "agent-1",
        }),
        expect.objectContaining({
          id: SAVED_CLOCK_ID,
          kind: "clock",
        }),
      ]),
    );
    expect(toast.warning).not.toHaveBeenCalledWith(
      "home:widgetLayer.toasts.conflict",
    );
    expect(useHomeWidgetStore.getState().itemRevision).toBe(12);
    expect(useHomeWidgetStore.getState().instances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agentPin",
          state: { agentId: "agent-1" },
        }),
      ]),
    );
  });

  it("restores last confirmed layout after save error", async () => {
    const confirmed = layout({ itemRevision: 7 });
    setReadyHomeState({
      itemRevision: 7,
      lastConfirmedLayout: confirmed,
    });
    vi.mocked(saveLayoutItems).mockRejectedValue("write failed");

    useHomeWidgetStore.getState().moveWidget("w1", 96, 96, CANVAS_BOUNDS);
    await flushMicrotasks();

    expect(useHomeWidgetStore.getState().instances[0].id).toBe(
      BACKEND_CLOCK_ID,
    );
    expect(useHomeWidgetStore.getState().itemRevision).toBe(7);
    expect(toast.error).toHaveBeenCalledWith(
      "home:widgetLayer.toasts.saveFailed",
    );
  });

  it("clears cleanup snapshot when a cleanup save fails", async () => {
    setReadyHomeState({
      instances: [
        clockWidget({ id: BACKEND_CLOCK_ID, x: 48, y: 72, z: 5, width: 300 }),
      ],
    });
    vi.mocked(saveLayoutItems).mockRejectedValue("write failed");

    useHomeWidgetStore.getState().toggleCleanUpWidgets(CANVAS_BOUNDS);
    expect(useHomeWidgetStore.getState().cleanUpSnapshot).not.toBeNull();
    await flushMicrotasks();

    expect(useHomeWidgetStore.getState().cleanUpSnapshot).toBeNull();
    expect(localStorage.getItem(CLEAN_UP_SNAPSHOT_STORAGE_KEY)).toBeNull();
  });

  it("clears saving state after a synchronous save error", async () => {
    setReadyHomeState({
      itemRevision: 7,
      lastConfirmedLayout: layout({ itemRevision: 7 }),
    });
    vi.mocked(saveLayoutItems).mockImplementation(() => {
      throw new Error("write failed before promise");
    });

    useHomeWidgetStore.getState().moveWidget("w1", 96, 96, CANVAS_BOUNDS);
    await flushMicrotasks();

    expect(useHomeWidgetStore.getState().saveStatus).toBe("idle");
    expect(toast.error).toHaveBeenCalledWith(
      "home:widgetLayer.toasts.saveFailed",
    );
  });

  it("ignores stale in-flight save results after a fresh initialization", async () => {
    const oldSave = deferred<SaveItemsResult>();
    const freshLayout = layout({ itemRevision: 12 });
    vi.mocked(saveLayoutItems).mockReturnValue(oldSave.promise);
    vi.mocked(getLayout).mockResolvedValue(freshLayout);
    setReadyHomeState();

    useHomeWidgetStore.getState().moveWidget("w1", 96, 96, CANVAS_BOUNDS);
    useHomeWidgetStore.setState({ loadStatus: "error", error: "reload" });
    await useHomeWidgetStore.getState().retryInitialize();

    oldSave.resolve({
      ok: false,
      reason: "revisionConflict",
      layout: layout({ itemRevision: 5 }),
    });
    await flushMicrotasks();

    expect(useHomeWidgetStore.getState().itemRevision).toBe(12);
    expect(useHomeWidgetStore.getState().instances[0].id).toBe(
      BACKEND_CLOCK_ID,
    );
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
