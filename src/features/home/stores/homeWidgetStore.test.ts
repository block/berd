import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { Layout } from "@/features/layout/api/layout";
import {
  getLayout,
  HOME_LAYOUT_ID,
  saveLayoutItems,
} from "@/features/layout/api/layout";
import { HOME_LAYOUT_REPLACE_KINDS } from "../lib/homeLayoutMapper";
import {
  resetHomeWidgetStoreForTests,
  useHomeWidgetStore,
} from "./homeWidgetStore";

vi.mock("@/features/layout/api/layout", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/layout/api/layout")>();
  return {
    ...actual,
    getLayout: vi.fn(),
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

function layout(overrides: Partial<Layout> = {}): Layout {
  return {
    layoutId: HOME_LAYOUT_ID,
    itemRevision: 4,
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
        zIndex: 2,
        titleOverride: null,
      },
    ],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  resetHomeWidgetStoreForTests();
  vi.mocked(getLayout).mockReset();
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
    expect(useHomeWidgetStore.getState()).toMatchObject({
      loadStatus: "ready",
      itemRevision: 4,
    });
    expect(useHomeWidgetStore.getState().instances).toMatchObject([
      { id: "00000000-0000-0000-0000-000000000001", type: "clock", z: 2 },
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
      "00000000-0000-0000-0000-000000000001",
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
    const pendingSave = deferred<Awaited<ReturnType<typeof saveLayoutItems>>>();
    useHomeWidgetStore.setState({
      instances: [
        {
          id: "00000000-0000-0000-0000-000000000001",
          type: "clock",
          x: 120,
          y: 120,
          z: 1,
        },
      ],
      itemRevision: 4,
      lastConfirmedLayout: layout(),
      loadStatus: "ready",
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

    expect(useHomeWidgetStore.getState().instances).toEqual([
      { id: "w1", type: "clock", x: 0, y: 0, z: 1 },
    ]);
    expect(saveLayoutItems).not.toHaveBeenCalled();
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
    useHomeWidgetStore.setState({
      instances: [
        {
          id: "w1",
          type: "clock",
          x: 24,
          y: 24,
          z: 1,
          state: { mode: "local" },
        },
      ],
      itemRevision: 4,
      lastConfirmedLayout: layout(),
      loadStatus: "ready",
    });
    const before = useHomeWidgetStore.getState().instances;

    act();

    expect(useHomeWidgetStore.getState().instances).toBe(before);
    expect(saveLayoutItems).not.toHaveBeenCalled();
  });

  it("coalesces queued mutations while a save is in flight", async () => {
    const firstSave = deferred<Awaited<ReturnType<typeof saveLayoutItems>>>();
    vi.mocked(saveLayoutItems)
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValue({
        ok: true,
        layout: layout({ itemRevision: 6 }),
      });
    useHomeWidgetStore.setState({
      instances: [{ id: "w1", type: "clock", x: 0, y: 0, z: 1 }],
      itemRevision: 4,
      lastConfirmedLayout: layout(),
      loadStatus: "ready",
    });

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
      zIndex: 2,
    });
    expect(secondRequest.items).toHaveLength(1);
  });

  it("adopts returned backend layout after a successful save", async () => {
    useHomeWidgetStore.setState({
      instances: [{ id: "w1", type: "clock", x: 0, y: 0, z: 1 }],
      itemRevision: 4,
      lastConfirmedLayout: layout(),
      loadStatus: "ready",
    });
    vi.mocked(saveLayoutItems).mockResolvedValue({
      ok: true,
      layout: layout({ itemRevision: 9 }),
    });

    useHomeWidgetStore.getState().moveWidget("w1", 24, 24, CANVAS_BOUNDS);
    await flushMicrotasks();

    expect(useHomeWidgetStore.getState().itemRevision).toBe(9);
    expect(useHomeWidgetStore.getState().instances[0].id).toBe(
      "00000000-0000-0000-0000-000000000001",
    );
  });

  it("adopts conflict layout and drops queued local changes", async () => {
    const conflict = layout({ itemRevision: 11 });
    useHomeWidgetStore.setState({
      instances: [{ id: "w1", type: "clock", x: 0, y: 0, z: 1 }],
      itemRevision: 4,
      lastConfirmedLayout: layout(),
      loadStatus: "ready",
    });
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
          id: "00000000-0000-0000-0000-000000000001",
        }),
      ]),
    );
  });

  it("restores last confirmed layout after save error", async () => {
    const confirmed = layout({ itemRevision: 7 });
    useHomeWidgetStore.setState({
      instances: [{ id: "w1", type: "clock", x: 0, y: 0, z: 1 }],
      itemRevision: 7,
      lastConfirmedLayout: confirmed,
      loadStatus: "ready",
    });
    vi.mocked(saveLayoutItems).mockRejectedValue("write failed");

    useHomeWidgetStore.getState().moveWidget("w1", 96, 96, CANVAS_BOUNDS);
    await flushMicrotasks();

    expect(useHomeWidgetStore.getState().instances[0].id).toBe(
      "00000000-0000-0000-0000-000000000001",
    );
    expect(useHomeWidgetStore.getState().itemRevision).toBe(7);
    expect(toast.error).toHaveBeenCalledWith(
      "home:widgetLayer.toasts.saveFailed",
    );
  });

  it("clears saving state after a synchronous save error", async () => {
    useHomeWidgetStore.setState({
      instances: [{ id: "w1", type: "clock", x: 0, y: 0, z: 1 }],
      itemRevision: 7,
      lastConfirmedLayout: layout({ itemRevision: 7 }),
      loadStatus: "ready",
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
    const oldSave = deferred<Awaited<ReturnType<typeof saveLayoutItems>>>();
    const freshLayout = layout({ itemRevision: 12 });
    vi.mocked(saveLayoutItems).mockReturnValue(oldSave.promise);
    vi.mocked(getLayout).mockResolvedValue(freshLayout);
    useHomeWidgetStore.setState({
      instances: [{ id: "w1", type: "clock", x: 0, y: 0, z: 1 }],
      itemRevision: 4,
      lastConfirmedLayout: layout(),
      loadStatus: "ready",
    });

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
      "00000000-0000-0000-0000-000000000001",
    );
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
