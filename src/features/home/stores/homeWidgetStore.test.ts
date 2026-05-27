import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { Layout, LayoutCamera } from "@/features/layout/api/layout";
import {
  getLayout,
  HOME_LAYOUT_ID,
  saveLayoutCamera,
  saveLayoutItems,
} from "@/features/layout/api/layout";
import { HOME_LAYOUT_REPLACE_KINDS } from "../lib/homeLayoutMapper";
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
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.warning).mockClear();
  localStorage.clear();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  });
});

describe("homeWidgetStore", () => {
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

  it("seeds a default clock when backend returns zero typed items", async () => {
    vi.mocked(getLayout).mockResolvedValue(
      layout({ itemRevision: 7, items: [] }),
    );
    vi.mocked(saveLayoutItems).mockResolvedValue({
      ok: true,
      layout: layout({ itemRevision: 8 }),
    });

    await useHomeWidgetStore.getState().initialize();

    expect(saveLayoutItems).toHaveBeenCalledWith(
      expect.objectContaining({
        layoutId: HOME_LAYOUT_ID,
        expectedRevision: 7,
        replaceKinds: HOME_LAYOUT_REPLACE_KINDS,
      }),
    );
    expect(useHomeWidgetStore.getState().loadStatus).toBe("ready");
    expect(useHomeWidgetStore.getState().itemRevision).toBe(8);
  });

  it("does not seed a clock when backend layout has other widgets but no clock", async () => {
    // If the user unpinned the clock, that choice must be respected across
    // reloads. Auto-seeding only fires for genuinely empty layouts; layouts
    // with any item are taken as-is.
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

  it("adopts the backend layout when default clock seeding conflicts", async () => {
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

  it("uses a uuid for the generated default clock id", async () => {
    vi.mocked(getLayout).mockResolvedValue(layout({ items: [] }));
    vi.mocked(saveLayoutItems).mockResolvedValue({
      ok: true,
      layout: layout(),
    });

    await useHomeWidgetStore.getState().initialize();

    const request = vi.mocked(saveLayoutItems).mock.calls[0][0];
    expect(request.items[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(request.items[0].id).not.toBe("default-clock");
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
      centerX: 168,
      centerY: 168,
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
