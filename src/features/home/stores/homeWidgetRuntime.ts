import { toast } from "sonner";
import { BERDY_ONBOARDING_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { getExperiment } from "@/features/experiments/experimentPreferences";
import {
  getLayout,
  HOME_LAYOUT_ID,
  saveLayoutCamera,
  saveLayoutItems,
  type Layout,
  type LayoutCamera,
  type LayoutConstraints,
} from "@/features/layout/api/layout";
import { i18n } from "@/shared/i18n";
import { markStarterAgentPinsEligible } from "@/features/home/onboarding/starterAgents";
import {
  clearPendingStarterHomeCamera,
  getPendingStarterHomeCamera,
  markStarterHomeCameraPending,
  markStarterHomeLayoutEligible,
} from "@/features/home/onboarding/starterHomeLayout";
import { createStarterHomeWidgets } from "@/features/home/onboarding/createStarterHomeWidgets";
import {
  notifyHomeCameraSaveConfirmed,
  notifyHomeCameraSaveDiscarded,
} from "@/features/home/onboarding/homeWidgetSaveLifecycle";
import {
  createDefaultHomeLayoutItems,
  createDefaultOnboardingWidgets,
  defaultStickyNoteId,
  homeWidgetsToLayoutItems,
  HOME_LAYOUT_REPLACE_KINDS,
  layoutItemsToHomeWidgets,
  reconcileOnboardingExperimentWidgets,
} from "../lib/homeLayoutMapper";
import type { WidgetInstance } from "../widgets/types";

const ONBOARDING_STICKIES_SEEDED_STORAGE_KEY =
  "goose:home:onboarding-stickies-seeded";
const ONBOARDING_STICKIES_SEEDED_VERSION = 6;
const ONBOARDING_STICKY_INTRODUCED_VERSION: Record<string, number> = {
  "onboarding:tour": 6,
  "onboarding:welcome": 5,
  "onboarding:build-agent": 1,
  "onboarding:start-project": 1,
  "onboarding:reuse-workflows": 3,
  "onboarding:shape-home": 3,
  "onboarding:manage-automations": 4,
};
const LEGACY_DEFAULT_STICKY_NOTE_POSITIONS_BY_ID: Record<
  string,
  { x: number; y: number; width: number; height: number }
> = {
  "onboarding:welcome": { x: -360, y: -250, width: 224, height: 196 },
  "onboarding:start-project": { x: -96, y: -250, width: 224, height: 196 },
  "onboarding:build-agent": { x: 168, y: -250, width: 224, height: 196 },
  "onboarding:reuse-workflows": { x: -360, y: -14, width: 224, height: 196 },
  "onboarding:manage-automations": {
    x: -96,
    y: -14,
    width: 224,
    height: 196,
  },
  "onboarding:shape-home": { x: 168, y: -14, width: 224, height: 196 },
};

export type LoadStatus = "idle" | "loading" | "ready" | "error";
export type SaveStatus = "idle" | "saving";

export type HomeWidgetState = {
  instances: WidgetInstance[];
  loadStatus: LoadStatus;
  saveStatus: SaveStatus;
  error: string | null;
  itemRevision: number | null;
  camera: LayoutCamera | null;
  cameraRevision: number | null;
  constraints: LayoutConstraints | null;
  cameraSaveStatus: SaveStatus;
  lastConfirmedLayout: Layout | null;
};

type StatePatch =
  | Partial<HomeWidgetState>
  | ((state: HomeWidgetState) => Partial<HomeWidgetState>);

type LayoutState = Pick<
  HomeWidgetState,
  | "instances"
  | "itemRevision"
  | "camera"
  | "cameraRevision"
  | "constraints"
  | "lastConfirmedLayout"
>;

type CameraState = Pick<
  HomeWidgetState,
  "camera" | "cameraRevision" | "constraints" | "lastConfirmedLayout"
>;

type HomeWidgetRuntimeOptions = {
  getState: () => HomeWidgetState;
  onItemSaveConfirmed?: () => void;
  onItemSaveDiscarded?: () => void;
  setState: (patch: StatePatch) => void;
};

type RuntimeState = {
  generation: number;
  initializePromise: Promise<void> | null;
  queuedInstances: WidgetInstance[] | null;
  queuedCamera: LayoutCamera | null;
  saveLoopPromise: Promise<void> | null;
  saveLoopGeneration: number | null;
  cameraSaveLoopPromise: Promise<void> | null;
  cameraSaveLoopGeneration: number | null;
};

export const MAX_STARTUP_ATTEMPTS = 3;

export const initialHomeWidgetState = {
  instances: [],
  loadStatus: "idle",
  saveStatus: "idle",
  error: null,
  itemRevision: null,
  camera: null,
  cameraRevision: null,
  constraints: null,
  cameraSaveStatus: "idle",
  lastConfirmedLayout: null,
} satisfies HomeWidgetState;

function formatErrorDetails(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    const details = [
      error.name ? `name: ${error.name}` : null,
      error.message ? `message: ${error.message}` : null,
      error.stack ? `stack: ${error.stack}` : null,
      "cause" in error && error.cause !== undefined
        ? `cause: ${formatErrorDetails(error.cause)}`
        : null,
    ].filter(Boolean);

    return details.length > 0 ? details.join("\n") : String(error);
  }
  return String(error);
}

function adoptLayout(layout: Layout): LayoutState {
  return {
    instances: layoutItemsToHomeWidgets(layout.items),
    itemRevision: layout.itemRevision,
    camera: layout.camera,
    cameraRevision: layout.cameraRevision,
    constraints: layout.constraints,
    lastConfirmedLayout: layout,
  };
}

function adoptLayoutCamera(
  layout: Layout,
  current: HomeWidgetState,
): CameraState {
  return {
    camera: layout.camera,
    cameraRevision: layout.cameraRevision,
    constraints: layout.constraints,
    lastConfirmedLayout: {
      ...(current.lastConfirmedLayout ?? layout),
      camera: layout.camera,
      cameraRevision: layout.cameraRevision,
      constraints: layout.constraints,
    },
  };
}

function adoptLayoutItems(
  layout: Layout,
  current: HomeWidgetState,
  preserveCurrentCamera: boolean,
): LayoutState {
  if (
    preserveCurrentCamera &&
    current.camera !== null &&
    current.cameraRevision !== null
  ) {
    return adoptLayout({
      ...layout,
      camera: current.camera,
      cameraRevision: current.cameraRevision,
    });
  }

  return adoptLayout(layout);
}

function stableStateKey(state: WidgetInstance["state"]): string {
  if (!state) {
    return "";
  }

  return JSON.stringify(
    Object.keys(state)
      .sort()
      .map((key) => [key, state[key]]),
  );
}

function widgetIdentityKey(instance: WidgetInstance): string {
  return `${instance.type}:${stableStateKey(instance.state)}`;
}

function onboardingStickiesSeenVersion(): number {
  try {
    const value = localStorage.getItem(ONBOARDING_STICKIES_SEEDED_STORAGE_KEY);
    const version = value ? Number.parseInt(value, 10) : 0;
    return Number.isFinite(version) ? version : 0;
  } catch {
    return ONBOARDING_STICKIES_SEEDED_VERSION;
  }
}

function markOnboardingStickiesSeen(): void {
  try {
    localStorage.setItem(
      ONBOARDING_STICKIES_SEEDED_STORAGE_KEY,
      String(ONBOARDING_STICKIES_SEEDED_VERSION),
    );
  } catch {
    // Ignore unavailable storage; the layout itself is still the source of truth.
  }
}

function clearOnboardingStickiesSeenForTests(): void {
  try {
    localStorage.removeItem(ONBOARDING_STICKIES_SEEDED_STORAGE_KEY);
  } catch {
    // Ignore unavailable storage in non-browser tests.
  }
}

function hasStickyNote(instances: WidgetInstance[]): boolean {
  return instances.some((instance) => instance.type === "stickyNote");
}

function withMissingDefaultStickyNotes(
  instances: WidgetInstance[],
  berdyOnboardingEnabled: boolean,
): WidgetInstance[] {
  const seenVersion = onboardingStickiesSeenVersion();
  if (seenVersion >= ONBOARDING_STICKIES_SEEDED_VERSION) {
    return instances;
  }

  const existingNoteIds = new Set(
    instances.flatMap((instance) => {
      const noteId = defaultStickyNoteId(instance);
      return noteId ? [noteId] : [];
    }),
  );
  const missingStickyNotes = createDefaultOnboardingWidgets(
    berdyOnboardingEnabled,
  ).filter((instance) => {
    const noteId = defaultStickyNoteId(instance);
    if (noteId === "onboarding:tour" && !berdyOnboardingEnabled) {
      return false;
    }
    if (!noteId || existingNoteIds.has(noteId)) {
      return false;
    }
    const introducedVersion =
      ONBOARDING_STICKY_INTRODUCED_VERSION[noteId] ??
      ONBOARDING_STICKIES_SEEDED_VERSION;
    return seenVersion < introducedVersion;
  });
  if (missingStickyNotes.length === 0) {
    return instances;
  }

  const maxZ = instances.reduce(
    (currentMax, instance) => Math.max(currentMax, instance.z),
    0,
  );
  const stickyNotes = missingStickyNotes.map((instance, index) => ({
    ...instance,
    z: maxZ + index + 1,
  }));

  return [...instances, ...stickyNotes];
}

function defaultStickyNotePositionsById(
  berdyOnboardingEnabled: boolean,
): Map<string, { x: number; y: number; width: number; height: number }> {
  return new Map(
    createDefaultOnboardingWidgets(berdyOnboardingEnabled).flatMap(
      (instance) => {
        const noteId = defaultStickyNoteId(instance);
        if (!noteId || !instance.width || !instance.height) {
          return [];
        }
        return [
          [
            noteId,
            {
              x: instance.x,
              y: instance.y,
              width: instance.width,
              height: instance.height,
            },
          ],
        ];
      },
    ),
  );
}

function withSnappedDefaultStickyNotePositions(
  instances: WidgetInstance[],
  berdyOnboardingEnabled: boolean,
): WidgetInstance[] {
  const currentPositionsById = defaultStickyNotePositionsById(
    berdyOnboardingEnabled,
  );
  let changed = false;

  const nextInstances = instances.map((instance) => {
    const noteId = defaultStickyNoteId(instance);
    if (!noteId) {
      return instance;
    }

    const legacyPosition = LEGACY_DEFAULT_STICKY_NOTE_POSITIONS_BY_ID[noteId];
    const currentPosition = currentPositionsById.get(noteId);
    if (!legacyPosition || !currentPosition) {
      return instance;
    }

    const matchesLegacyPosition =
      instance.x === legacyPosition.x &&
      instance.y === legacyPosition.y &&
      instance.width === legacyPosition.width &&
      instance.height === legacyPosition.height;
    if (!matchesLegacyPosition) {
      return instance;
    }

    changed = true;
    return {
      ...instance,
      x: currentPosition.x,
      y: currentPosition.y,
    };
  });

  return changed ? nextInstances : instances;
}

function mergeAddedWidgetsAfterConflict(
  current: HomeWidgetState,
  attemptedInstances: WidgetInstance[],
  conflictLayout: Layout,
): WidgetInstance[] | null {
  const confirmedIds = new Set(
    current.lastConfirmedLayout
      ? layoutItemsToHomeWidgets(current.lastConfirmedLayout.items).map(
          (instance) => instance.id,
        )
      : current.instances.map((instance) => instance.id),
  );
  const addedInstances = attemptedInstances.filter(
    (instance) => !confirmedIds.has(instance.id),
  );
  if (addedInstances.length === 0) {
    return null;
  }

  const conflictInstances = layoutItemsToHomeWidgets(conflictLayout.items);
  const conflictKeys = new Set(conflictInstances.map(widgetIdentityKey));
  const mergeableAddedInstances = addedInstances.filter(
    (instance) => !conflictKeys.has(widgetIdentityKey(instance)),
  );
  if (mergeableAddedInstances.length === 0) {
    return null;
  }

  const maxZ = conflictInstances.reduce(
    (currentMax, instance) => Math.max(currentMax, instance.z),
    0,
  );
  const rehydratedAddedInstances = mergeableAddedInstances.map(
    (instance, index) => ({
      ...instance,
      z: maxZ + index + 1,
    }),
  );

  return [...conflictInstances, ...rehydratedAddedInstances];
}

export function createHomeWidgetRuntime({
  getState,
  onItemSaveConfirmed,
  onItemSaveDiscarded,
  setState,
}: HomeWidgetRuntimeOptions) {
  const runtime: RuntimeState = {
    generation: 0,
    initializePromise: null,
    queuedInstances: null,
    queuedCamera: null,
    saveLoopPromise: null,
    saveLoopGeneration: null,
    cameraSaveLoopPromise: null,
    cameraSaveLoopGeneration: null,
  };

  function shouldPreserveCurrentCamera(
    current: HomeWidgetState,
    layout: Layout,
  ): boolean {
    return (
      current.camera !== null &&
      current.cameraRevision !== null &&
      (runtime.queuedCamera !== null ||
        runtime.cameraSaveLoopPromise !== null ||
        current.cameraRevision > layout.cameraRevision)
    );
  }

  function adoptSavedItems(
    layout: Layout,
    current: HomeWidgetState,
  ): LayoutState {
    return adoptLayoutItems(
      layout,
      current,
      shouldPreserveCurrentCamera(current, layout),
    );
  }

  function setReadyLayout(layout: Layout, generation: number): void {
    if (generation !== runtime.generation) return;
    setState({
      ...adoptLayout(layout),
      loadStatus: "ready",
      error: null,
    });

    const pending = getPendingStarterHomeCamera();
    if (!pending) return;
    if (pending.expectedRevision !== layout.cameraRevision) {
      clearPendingStarterHomeCamera();
      return;
    }
    setState({ camera: pending.camera });
    enqueueCameraSave(pending.camera);
    void waitForPendingSaves();
  }

  async function loadFromBackend(generation: number): Promise<void> {
    let lastError = "";

    for (let attempt = 0; attempt < MAX_STARTUP_ATTEMPTS; attempt += 1) {
      try {
        const layout = await getLayout(HOME_LAYOUT_ID);
        if (generation !== runtime.generation) {
          return;
        }

        const berdyOnboardingEnabled =
          getExperiment(BERDY_ONBOARDING_EXPERIMENT_ID)?.enabled === true;
        const instances = layoutItemsToHomeWidgets(layout.items);
        if (instances.length > 0) {
          const instancesWithoutWelcome = reconcileOnboardingExperimentWidgets(
            instances,
            berdyOnboardingEnabled,
          );
          const instancesWithMissingNotes = withMissingDefaultStickyNotes(
            instancesWithoutWelcome,
            berdyOnboardingEnabled,
          );
          const preparedInstances = withSnappedDefaultStickyNotePositions(
            instancesWithMissingNotes,
            berdyOnboardingEnabled,
          );
          if (preparedInstances !== instances) {
            const result = await saveLayoutItems({
              layoutId: HOME_LAYOUT_ID,
              expectedRevision: layout.itemRevision,
              replaceKinds: HOME_LAYOUT_REPLACE_KINDS,
              items: homeWidgetsToLayoutItems(preparedInstances),
            });
            if (generation !== runtime.generation) {
              return;
            }
            if (hasStickyNote(layoutItemsToHomeWidgets(result.layout.items))) {
              markOnboardingStickiesSeen();
            }
            setReadyLayout(result.layout, generation);
            return;
          }

          if (hasStickyNote(instances)) {
            markOnboardingStickiesSeen();
          }
          setReadyLayout(layout, generation);
          return;
        }

        if (!berdyOnboardingEnabled) {
          const defaultItems = createDefaultHomeLayoutItems(undefined, false);
          const result = await saveLayoutItems({
            layoutId: HOME_LAYOUT_ID,
            expectedRevision: layout.itemRevision,
            replaceKinds: HOME_LAYOUT_REPLACE_KINDS,
            items: defaultItems,
          });
          if (generation !== runtime.generation) return;
          if (hasStickyNote(layoutItemsToHomeWidgets(result.layout.items))) {
            markOnboardingStickiesSeen();
          }
          setReadyLayout(result.layout, generation);
          return;
        }

        // Starter-agent pins are optional enrichment. Persist the usable Home
        // immediately, then let Home recover pins when persona discovery is ready.
        const starterWidgets = createStarterHomeWidgets([]);

        const result = await saveLayoutItems({
          layoutId: HOME_LAYOUT_ID,
          expectedRevision: layout.itemRevision,
          replaceKinds: HOME_LAYOUT_REPLACE_KINDS,
          items: homeWidgetsToLayoutItems(starterWidgets),
        });
        if (generation !== runtime.generation) return;
        if (hasStickyNote(layoutItemsToHomeWidgets(result.layout.items))) {
          markOnboardingStickiesSeen();
        }
        if (!result.ok) {
          setReadyLayout(result.layout, generation);
          return;
        }

        markStarterAgentPinsEligible();
        markStarterHomeLayoutEligible();

        const starterCamera = {
          ...result.layout.camera,
          centerX: 0,
          centerY: 40,
          zoomBps: 10_000,
        };
        const cameraRevisionBeforeSave = result.layout.cameraRevision;
        setReadyLayout({ ...result.layout, camera: starterCamera }, generation);
        enqueueCameraSave(starterCamera);
        await waitForPendingSaves();
        if (generation !== runtime.generation) return;
        const savedState = getState();
        const cameraSaved =
          savedState.cameraRevision !== cameraRevisionBeforeSave &&
          savedState.camera?.centerX === starterCamera.centerX &&
          savedState.camera.centerY === starterCamera.centerY &&
          savedState.camera.zoomBps === starterCamera.zoomBps;
        if (!cameraSaved) {
          markStarterHomeCameraPending({
            expectedRevision: cameraRevisionBeforeSave,
            camera: starterCamera,
          });
        }
        return;
      } catch (error) {
        if (generation !== runtime.generation) {
          return;
        }
        lastError = formatErrorDetails(error);
      }
    }

    if (generation !== runtime.generation) {
      return;
    }

    setState({
      loadStatus: "error",
      error: lastError,
    });
  }

  function initialize(force = false): Promise<void> {
    const { itemRevision, loadStatus } = getState();
    if (!force && loadStatus === "ready" && itemRevision !== null) {
      return Promise.resolve();
    }

    if (!force && runtime.initializePromise) {
      return runtime.initializePromise;
    }

    runtime.generation += 1;
    runtime.queuedInstances = null;
    runtime.queuedCamera = null;
    const generation = runtime.generation;

    setState({
      ...initialHomeWidgetState,
      loadStatus: "loading",
    });

    runtime.initializePromise = loadFromBackend(generation).finally(() => {
      // A reset or fresh initialize advances the generation; older callers may
      // still await their promise, but it must not clear the active request.
      if (generation === runtime.generation) {
        runtime.initializePromise = null;
      }
    });
    return runtime.initializePromise;
  }

  function retryInitialize(): Promise<void> {
    const { loadStatus } = getState();
    if (loadStatus === "loading" && runtime.initializePromise) {
      return runtime.initializePromise;
    }
    if (loadStatus !== "error") {
      return Promise.resolve();
    }
    return initialize(true);
  }

  async function drainSaveQueue(): Promise<void> {
    const generation = runtime.generation;
    if (runtime.saveLoopPromise && runtime.saveLoopGeneration === generation) {
      return runtime.saveLoopPromise;
    }

    runtime.saveLoopGeneration = generation;

    const loopPromise = (async () => {
      setState({ saveStatus: "saving" });
      try {
        while (runtime.queuedInstances) {
          const instances = runtime.queuedInstances;
          runtime.queuedInstances = null;
          const expectedRevision = getState().itemRevision;
          if (expectedRevision === null) {
            continue;
          }

          try {
            const result = await saveLayoutItems({
              layoutId: HOME_LAYOUT_ID,
              expectedRevision,
              replaceKinds: HOME_LAYOUT_REPLACE_KINDS,
              items: homeWidgetsToLayoutItems(instances),
            });

            if (generation !== runtime.generation) {
              break;
            }

            if (!result.ok) {
              const conflictState = getState();
              const pendingInstances = runtime.queuedInstances;
              const mergedInstances = mergeAddedWidgetsAfterConflict(
                conflictState,
                pendingInstances ?? instances,
                result.layout,
              );

              if (mergedInstances) {
                runtime.queuedInstances = mergedInstances;
                setState((current) => ({
                  ...adoptSavedItems(result.layout, current),
                  instances: mergedInstances,
                  error: null,
                }));
                continue;
              }

              runtime.queuedInstances = null;
              setState((current) => ({
                ...adoptSavedItems(result.layout, current),
                error: null,
              }));
              onItemSaveDiscarded?.();
              toast.warning(i18n.t("home:widgetLayer.toasts.conflict"));
              break;
            }

            setState((current) => ({
              ...adoptSavedItems(result.layout, current),
              instances: runtime.queuedInstances
                ? current.instances
                : layoutItemsToHomeWidgets(result.layout.items),
              error: null,
            }));
            if (!runtime.queuedInstances) {
              onItemSaveConfirmed?.();
            }
          } catch {
            if (generation !== runtime.generation) {
              break;
            }

            runtime.queuedInstances = null;
            setState((current) => ({
              ...(current.lastConfirmedLayout
                ? adoptSavedItems(current.lastConfirmedLayout, current)
                : {}),
              error: null,
            }));
            onItemSaveDiscarded?.();
            toast.error(i18n.t("home:widgetLayer.toasts.saveFailed"));
            break;
          }
        }
      } finally {
        if (
          generation === runtime.generation &&
          runtime.saveLoopGeneration === generation
        ) {
          runtime.saveLoopPromise = null;
          runtime.saveLoopGeneration = null;
          setState({ saveStatus: "idle" });
        }
      }
    })();

    runtime.saveLoopPromise = loopPromise;
    return loopPromise;
  }

  function enqueueSave(instances: WidgetInstance[]): void {
    runtime.queuedInstances = instances;
    void drainSaveQueue();
  }

  async function drainCameraSaveQueue(): Promise<void> {
    const generation = runtime.generation;
    if (
      runtime.cameraSaveLoopPromise &&
      runtime.cameraSaveLoopGeneration === generation
    ) {
      return runtime.cameraSaveLoopPromise;
    }

    runtime.cameraSaveLoopGeneration = generation;

    const loopPromise = (async () => {
      setState({ cameraSaveStatus: "saving" });
      try {
        while (runtime.queuedCamera) {
          const camera = runtime.queuedCamera;
          runtime.queuedCamera = null;
          const expectedRevision = getState().cameraRevision;
          if (expectedRevision === null) {
            continue;
          }

          try {
            const result = await saveLayoutCamera({
              layoutId: HOME_LAYOUT_ID,
              expectedRevision,
              camera,
            });

            if (generation !== runtime.generation) {
              break;
            }

            if (!result.ok) {
              runtime.queuedCamera = null;
              notifyHomeCameraSaveDiscarded();
              setState((current) => ({
                ...adoptLayoutCamera(result.layout, current),
                error: null,
              }));
              toast.warning(i18n.t("home:widgetLayer.toasts.conflict"));
              break;
            }

            setState((current) => ({
              ...adoptLayoutCamera(result.layout, current),
              camera: runtime.queuedCamera
                ? current.camera
                : result.layout.camera,
              error: null,
            }));
            if (!runtime.queuedCamera) {
              clearPendingStarterHomeCamera();
              notifyHomeCameraSaveConfirmed();
            }
          } catch {
            if (generation !== runtime.generation) {
              break;
            }

            runtime.queuedCamera = null;
            notifyHomeCameraSaveDiscarded();
            setState({ error: null });
            toast.error(i18n.t("home:widgetLayer.toasts.saveFailed"));
            break;
          }
        }
      } finally {
        if (
          generation === runtime.generation &&
          runtime.cameraSaveLoopGeneration === generation
        ) {
          runtime.cameraSaveLoopPromise = null;
          runtime.cameraSaveLoopGeneration = null;
          setState({ cameraSaveStatus: "idle" });
        }
      }
    })();

    runtime.cameraSaveLoopPromise = loopPromise;
    return loopPromise;
  }

  function enqueueCameraSave(camera: LayoutCamera): void {
    runtime.queuedCamera = camera;
    void drainCameraSaveQueue();
  }

  async function waitForPendingSaves(): Promise<void> {
    await Promise.all([
      runtime.saveLoopPromise ?? Promise.resolve(),
      runtime.cameraSaveLoopPromise ?? Promise.resolve(),
    ]);
  }

  function __resetForTests__(): void {
    // Callers awaiting an in-flight initialize may receive a resolved promise
    // without any state change after reset advances the active generation.
    runtime.generation += 1;
    runtime.initializePromise = null;
    runtime.queuedInstances = null;
    runtime.queuedCamera = null;
    runtime.saveLoopPromise = null;
    runtime.saveLoopGeneration = null;
    runtime.cameraSaveLoopPromise = null;
    runtime.cameraSaveLoopGeneration = null;
    clearOnboardingStickiesSeenForTests();
    setState(initialHomeWidgetState);
  }

  return {
    initialize,
    retryInitialize,
    enqueueSave,
    enqueueCameraSave,
    waitForPendingSaves,
    __resetForTests__,
  };
}
