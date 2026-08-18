import { toast } from "sonner";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { BERDY_ONBOARDING_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import {
  STARTER_PROJECT_ID,
  STARTER_TASKS_NOTE_ID,
} from "@/features/home/onboarding/starterTasks";
import { notifyStarterWidgetAdded } from "@/features/home/onboarding/starterWidgetTask";
import { createStarterHomeWidgets } from "@/features/home/onboarding/createStarterHomeWidgets";
import {
  notifyHomeWidgetSaveConfirmed,
  notifyHomeWidgetSaveDiscarded,
} from "@/features/home/onboarding/homeWidgetSaveLifecycle";
import {
  clearStarterHomeLayoutEligibility,
  markStarterHomeArranged,
  markStarterHomeCameraPending,
  isStarterHomeLayoutEligible,
  resetStarterHomeArrangement,
  STARTER_HOME_LAYOUT,
} from "@/features/home/onboarding/starterHomeLayout";
import { getExperiment } from "@/features/experiments/experimentPreferences";
import {
  HOME_LAYOUT_ID,
  saveLayoutItems,
  type LayoutCamera,
  type LayoutConstraints,
  type LayoutMutationResult,
} from "@/features/layout/api/layout";
import { i18n } from "@/shared/i18n";
import { markFreshWidgetPlacement } from "../lib/freshWidgetPlacements";
import { isLayoutConstraints } from "../lib/snapToGrid";
import {
  createDefaultOnboardingTourWidget,
  defaultStickyNoteId,
  homeWidgetsToLayoutItems,
  HOME_LAYOUT_REPLACE_KINDS,
  layoutItemsToHomeWidgets,
  onboardingTourAvatarCenter,
  reconcileOnboardingExperimentWidgets,
} from "../lib/homeLayoutMapper";
import { HOME_WIDGET_CATALOG_BY_ID } from "../widgets/catalog";
import type {
  CanvasBounds,
  MoveWidgetOptions,
  WidgetInstance,
} from "../widgets/types";
import {
  addWidgetMutation,
  bumpZMutation,
  cleanUpWidgetsMutation,
  moveWidgetMutation,
  removeWidgetMutation,
  restoreWidgetsLayoutMutation,
  resizeWidgetMutation,
  type WidgetLayoutSnapshotItem,
  updateWidgetStateMutation,
} from "./homeWidgetMutations";
import {
  createHomeWidgetRuntime,
  initialHomeWidgetState,
  type HomeWidgetState,
} from "./homeWidgetRuntime";

function canMutateWidgets(state: HomeWidgetStore): boolean {
  return state.loadStatus === "ready" && state.itemRevision !== null;
}

type WidgetPlacementInput = CanvasBounds | LayoutConstraints;
const CLEAN_UP_SNAPSHOT_STORAGE_KEY = "goose:home:clean-up-snapshot";
const UNCHANGED_SNAPSHOT = Symbol("unchanged-clean-up-snapshot");
type PendingCleanUpSnapshot =
  | WidgetLayoutSnapshotItem[]
  | null
  | typeof UNCHANGED_SNAPSHOT;

function resolvePlacementBounds(
  bounds?: WidgetPlacementInput,
): LayoutConstraints | undefined {
  return isLayoutConstraints(bounds) ? bounds : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSnapshotItem(value: unknown): value is WidgetLayoutSnapshotItem {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const item = value as Record<string, unknown>;
  const hasOptionalSize =
    (item.width === undefined || isFiniteNumber(item.width)) &&
    (item.height === undefined || isFiniteNumber(item.height));

  return (
    typeof item.id === "string" &&
    typeof item.type === "string" &&
    isFiniteNumber(item.x) &&
    isFiniteNumber(item.y) &&
    isFiniteNumber(item.z) &&
    hasOptionalSize
  );
}

function loadCleanUpSnapshot(): WidgetLayoutSnapshotItem[] | null {
  try {
    const value = localStorage.getItem(CLEAN_UP_SNAPSHOT_STORAGE_KEY);
    if (!value) {
      return null;
    }

    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every(isSnapshotItem)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function saveCleanUpSnapshot(snapshot: WidgetLayoutSnapshotItem[]): void {
  try {
    localStorage.setItem(
      CLEAN_UP_SNAPSHOT_STORAGE_KEY,
      JSON.stringify(snapshot),
    );
  } catch {
    // The cleanup still works without a persisted restore snapshot.
  }
}

function persistCleanUpSnapshot(
  snapshot: WidgetLayoutSnapshotItem[] | null,
): void {
  if (snapshot) {
    saveCleanUpSnapshot(snapshot);
  } else {
    clearStoredCleanUpSnapshot();
  }
}

function clearStoredCleanUpSnapshot(): void {
  try {
    localStorage.removeItem(CLEAN_UP_SNAPSHOT_STORAGE_KEY);
  } catch {
    // Ignore unavailable storage in non-browser tests.
  }
}

function createCleanUpSnapshot(
  instances: WidgetInstance[],
): WidgetLayoutSnapshotItem[] {
  return instances.map(createCleanUpSnapshotItem);
}

function createCleanUpSnapshotItem({
  height,
  id,
  type,
  width,
  x,
  y,
  z,
}: WidgetInstance): WidgetLayoutSnapshotItem {
  return {
    id,
    type,
    x,
    y,
    z,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  };
}

function createAddedCleanUpSnapshotItem(
  instance: WidgetInstance,
): WidgetLayoutSnapshotItem {
  const item = createCleanUpSnapshotItem(instance);

  return {
    ...item,
    ...(item.width === undefined ? {} : { width: Math.round(item.width) }),
    ...(item.height === undefined ? {} : { height: Math.round(item.height) }),
  };
}

export type OnboardingHomeResetResult = {
  itemsConfirmed: boolean;
  cameraConfirmed: boolean;
  starterAgentsConfirmed?: boolean;
};

interface HomeWidgetStore extends HomeWidgetState {
  cleanUpSnapshot: WidgetLayoutSnapshotItem[] | null;
  initialize: () => Promise<void>;
  retryInitialize: () => Promise<void>;
  copyErrorDetails: () => Promise<void>;
  addWidget: (
    type: string,
    x: number,
    y: number,
    state?: Record<string, unknown>,
    bounds?: WidgetPlacementInput,
    options?: { notifyStarterTask?: boolean },
  ) => boolean;
  moveWidget: (
    id: string,
    x: number,
    y: number,
    bounds?: WidgetPlacementInput,
    options?: MoveWidgetOptions,
  ) => void;
  resizeWidget: (
    id: string,
    width: number,
    height: number,
    bounds?: WidgetPlacementInput,
    options?: MoveWidgetOptions,
  ) => void;
  bumpZ: (id: string) => void;
  applyStarterLayout: (
    instances: WidgetInstance[],
    camera: LayoutCamera | null,
  ) => Promise<boolean>;
  toggleCleanUpWidgets: (bounds?: WidgetPlacementInput) => void;
  syncOnboardingExperiment: (enabled: boolean) => void;
  resetOnboardingTour: () => Promise<boolean>;
  resetStarterTasks: () => Promise<boolean>;
  resetHomeForOnboarding: () => Promise<OnboardingHomeResetResult>;
  addMissingStarterAgentPins: (
    agentIds: readonly string[],
    legacyBerdyAgentId?: string | null,
  ) => Promise<boolean>;
  reloadOnboardingTourForDev: () => void;
  removeWidget: (id: string) => void;
  updateWidgetState: (
    id: string,
    state: Record<string, unknown>,
    bounds?: WidgetPlacementInput,
  ) => void;
  replaceChatPinSessionId: (
    draftSessionId: string,
    backendSessionId: string,
  ) => void;
  saveCamera: (camera: LayoutCamera) => void;
}

function createHomeWidgetStore() {
  let store!: UseBoundStore<StoreApi<HomeWidgetStore>>;
  let cleanUpSnapshotOnSaveConfirmed: PendingCleanUpSnapshot =
    UNCHANGED_SNAPSHOT;
  let cleanUpSnapshotOnSaveDiscarded: PendingCleanUpSnapshot =
    UNCHANGED_SNAPSHOT;
  let starterWidgetCompletionPending = false;
  let starterAgentRecoveryPromise: Promise<boolean> | null = null;
  let onboardingResetInFlight = false;

  function applyPendingCleanUpSnapshot(snapshot: PendingCleanUpSnapshot): void {
    if (snapshot === UNCHANGED_SNAPSHOT) {
      return;
    }

    persistCleanUpSnapshot(snapshot);
    store.setState({ cleanUpSnapshot: snapshot });
  }

  function setCleanUpSaveOutcomes({
    confirmed = UNCHANGED_SNAPSHOT,
    discarded = UNCHANGED_SNAPSHOT,
  }: {
    confirmed?: PendingCleanUpSnapshot;
    discarded?: PendingCleanUpSnapshot;
  }): void {
    cleanUpSnapshotOnSaveConfirmed = confirmed;
    cleanUpSnapshotOnSaveDiscarded = discarded;
  }

  function clearPendingCleanUpSaveOutcomes(): void {
    setCleanUpSaveOutcomes({});
  }

  function handleItemSaveConfirmed(): void {
    applyPendingCleanUpSnapshot(cleanUpSnapshotOnSaveConfirmed);
    clearPendingCleanUpSaveOutcomes();
    if (starterWidgetCompletionPending) {
      starterWidgetCompletionPending = false;
      notifyStarterWidgetAdded();
    }
    notifyHomeWidgetSaveConfirmed();
  }

  function handleItemSaveDiscarded(): void {
    applyPendingCleanUpSnapshot(cleanUpSnapshotOnSaveDiscarded);
    clearPendingCleanUpSaveOutcomes();
    starterWidgetCompletionPending = false;
    notifyHomeWidgetSaveDiscarded();
  }

  const runtime = createHomeWidgetRuntime({
    getState: () => store.getState(),
    onItemSaveConfirmed: handleItemSaveConfirmed,
    onItemSaveDiscarded: handleItemSaveDiscarded,
    setState: (patch) => store.setState(patch),
  });

  store = create<HomeWidgetStore>()((set, get) => {
    function canAcceptMutation(state: HomeWidgetStore): boolean {
      return !onboardingResetInFlight && canMutateWidgets(state);
    }

    function applyMutation(
      mutate: (
        instances: HomeWidgetState["instances"],
      ) => HomeWidgetState["instances"] | null,
    ): void {
      const state = get();
      if (!canAcceptMutation(state)) {
        return;
      }

      const next = mutate(state.instances);
      if (!next) {
        return;
      }

      if (state.cleanUpSnapshot) {
        clearPendingCleanUpSaveOutcomes();
        persistCleanUpSnapshot(null);
      }
      set({
        instances: next,
        cleanUpSnapshot: null,
      });
      runtime.enqueueSave(next);
    }

    return {
      ...initialHomeWidgetState,
      cleanUpSnapshot: loadCleanUpSnapshot(),
      initialize: () => runtime.initialize(),
      retryInitialize: () => runtime.retryInitialize(),
      copyErrorDetails: async () => {
        const { error } = get();
        try {
          await navigator.clipboard.writeText(error ?? "");
          toast.success(i18n.t("home:widgetLayer.toasts.copySuccess"));
        } catch {
          toast.error(i18n.t("home:widgetLayer.toasts.copyFailed"));
        }
      },
      addMissingStarterAgentPins: (agentIds, legacyBerdyAgentId) => {
        if (starterAgentRecoveryPromise) return starterAgentRecoveryPromise;
        starterAgentRecoveryPromise = (async () => {
          const state = get();
          if (!canAcceptMutation(state) || agentIds.length === 0) return false;
          const retainedInstances = legacyBerdyAgentId
            ? state.instances.filter(
                (instance) =>
                  !(
                    instance.type === "agentPin" &&
                    instance.state?.agentId === legacyBerdyAgentId
                  ),
              )
            : state.instances;
          const pinnedAgentIds = new Set(
            retainedInstances.flatMap((instance) =>
              instance.type === "agentPin" &&
              typeof instance.state?.agentId === "string"
                ? [instance.state.agentId]
                : [],
            ),
          );
          const missingAgentIds = agentIds.filter(
            (agentId) => !pinnedAgentIds.has(agentId),
          );
          if (
            missingAgentIds.length === 0 &&
            retainedInstances === state.instances
          ) {
            return true;
          }

          let maxZ = retainedInstances.reduce(
            (currentMax, instance) => Math.max(currentMax, instance.z),
            0,
          );
          const nextInstances = [
            ...retainedInstances,
            ...missingAgentIds.map((agentId) => {
              const index = agentIds.indexOf(agentId);
              return {
                id: crypto.randomUUID(),
                type: "agentPin" as const,
                ...STARTER_HOME_LAYOUT.agents[index],
                z: ++maxZ,
                state: { agentId },
              };
            }),
          ];
          const initialItemRevision = state.itemRevision;
          set({ instances: nextInstances });
          runtime.enqueueSave(nextInstances);
          await runtime.waitForPendingSaves();
          const latest = get();
          return (
            latest.itemRevision !== initialItemRevision &&
            agentIds.every((agentId) =>
              latest.instances.some(
                (instance) =>
                  instance.type === "agentPin" &&
                  instance.state?.agentId === agentId,
              ),
            ) &&
            (!legacyBerdyAgentId ||
              !latest.instances.some(
                (instance) =>
                  instance.type === "agentPin" &&
                  instance.state?.agentId === legacyBerdyAgentId,
              ))
          );
        })().finally(() => {
          starterAgentRecoveryPromise = null;
        });
        return starterAgentRecoveryPromise;
      },
      addWidget: (type, x, y, state, bounds, options) => {
        clearStarterHomeLayoutEligibility();
        if (!HOME_WIDGET_CATALOG_BY_ID[type]) {
          return false;
        }

        const current = get();
        if (!canAcceptMutation(current)) {
          return false;
        }

        const placementBounds = resolvePlacementBounds(bounds);
        const id = crypto.randomUUID();

        if (current.cleanUpSnapshot) {
          const withManualPlacement = addWidgetMutation(current.instances, {
            id,
            type,
            x,
            y,
            state,
            bounds: placementBounds,
          });
          if (!withManualPlacement) {
            return false;
          }

          const added = withManualPlacement.find(
            (instance) => instance.id === id,
          );
          if (!added) {
            return false;
          }

          const nextSnapshot = [
            ...current.cleanUpSnapshot,
            createAddedCleanUpSnapshotItem(added),
          ];
          const next =
            cleanUpWidgetsMutation(withManualPlacement, placementBounds) ??
            withManualPlacement;

          // Mark only after the mutation succeeds so a rejected add does not
          // leave an orphaned entry in the fresh-placement registry.
          markFreshWidgetPlacement(id);
          persistCleanUpSnapshot(nextSnapshot);
          setCleanUpSaveOutcomes({ discarded: current.cleanUpSnapshot });
          set({
            instances: next,
            cleanUpSnapshot: nextSnapshot,
          });
          if (options?.notifyStarterTask !== false) {
            starterWidgetCompletionPending = true;
          }
          runtime.enqueueSave(next);
          return true;
        }

        const previousInstances = get().instances;
        applyMutation((instances) =>
          addWidgetMutation(instances, {
            id,
            type,
            x,
            y,
            state,
            bounds: placementBounds,
          }),
        );
        const added = get().instances !== previousInstances;
        if (added) {
          // Mark only after the mutation succeeds so a rejected add does not
          // leave an orphaned entry in the fresh-placement registry.
          markFreshWidgetPlacement(id);
          if (options?.notifyStarterTask !== false) {
            starterWidgetCompletionPending = true;
          }
        }
        return added;
      },
      moveWidget: (id, x, y, bounds, options) => {
        clearStarterHomeLayoutEligibility();
        applyMutation((instances) =>
          moveWidgetMutation(
            instances,
            id,
            x,
            y,
            resolvePlacementBounds(bounds),
            options,
          ),
        );
      },
      resizeWidget: (id, width, height, bounds, options) => {
        clearStarterHomeLayoutEligibility();
        applyMutation((instances) =>
          resizeWidgetMutation(
            instances,
            id,
            width,
            height,
            resolvePlacementBounds(bounds),
            options,
          ),
        );
      },
      bumpZ: (id) => {
        applyMutation((instances) => bumpZMutation(instances, id));
      },
      applyStarterLayout: async (instances, camera) => {
        const state = get();
        if (!canAcceptMutation(state) || !isStarterHomeLayoutEligible()) {
          return false;
        }
        const initialItemRevision = state.itemRevision;
        const initialCameraRevision = state.cameraRevision;
        set({ instances, ...(camera ? { camera } : {}) });
        runtime.enqueueSave(instances);
        if (camera) runtime.enqueueCameraSave(camera);
        await runtime.waitForPendingSaves();
        const latest = get();
        const requestedById = new Map(
          instances.map((instance) => [instance.id, instance]),
        );
        const itemsConfirmed =
          latest.itemRevision !== initialItemRevision &&
          latest.instances.length === instances.length &&
          latest.instances.every((actual) => {
            const expected = requestedById.get(actual.id);
            return (
              expected !== undefined &&
              actual.type === expected.type &&
              actual.x === expected.x &&
              actual.y === expected.y &&
              actual.width === expected.width &&
              actual.height === expected.height &&
              actual.z === expected.z &&
              actual.state?.agentId === expected.state?.agentId &&
              actual.state?.noteId === expected.state?.noteId
            );
          });
        const cameraConfirmed =
          !camera ||
          (latest.cameraRevision !== initialCameraRevision &&
            latest.camera?.centerX === camera.centerX &&
            latest.camera.centerY === camera.centerY &&
            latest.camera.zoomBps === camera.zoomBps);
        if (
          itemsConfirmed &&
          cameraConfirmed &&
          isStarterHomeLayoutEligible()
        ) {
          markStarterHomeArranged();
        }
        return itemsConfirmed && cameraConfirmed;
      },
      toggleCleanUpWidgets: (bounds) => {
        const state = get();
        if (!canAcceptMutation(state)) {
          return;
        }

        if (state.cleanUpSnapshot) {
          const restored = restoreWidgetsLayoutMutation(
            state.instances,
            state.cleanUpSnapshot,
          );
          persistCleanUpSnapshot(null);
          setCleanUpSaveOutcomes({
            confirmed: null,
            discarded: state.cleanUpSnapshot,
          });
          set({
            cleanUpSnapshot: null,
            ...(restored ? { instances: restored } : {}),
          });
          if (restored) {
            runtime.enqueueSave(restored);
          }
          return;
        }

        const snapshot = createCleanUpSnapshot(state.instances);
        const next = cleanUpWidgetsMutation(
          state.instances,
          resolvePlacementBounds(bounds),
        );
        if (!next) {
          return;
        }

        persistCleanUpSnapshot(snapshot);
        setCleanUpSaveOutcomes({ discarded: null });
        set({
          instances: next,
          cleanUpSnapshot: snapshot,
        });
        runtime.enqueueSave(next);
      },
      syncOnboardingExperiment: (enabled) => {
        applyMutation((instances) => {
          const next = reconcileOnboardingExperimentWidgets(instances, enabled);
          return next === instances ? null : next;
        });
      },
      resetOnboardingTour: async () => {
        const state = get();
        const berdyOnboardingEnabled =
          getExperiment(BERDY_ONBOARDING_EXPERIMENT_ID)?.enabled === true;
        if (!berdyOnboardingEnabled || !canAcceptMutation(state)) {
          return false;
        }

        const clock = state.instances.find(
          (instance) => instance.type === "clock",
        );
        const onboardingTour = createDefaultOnboardingTourWidget(clock);
        const avatarCenter = onboardingTourAvatarCenter(onboardingTour);
        const expectedCamera = state.camera
          ? {
              ...state.camera,
              centerX: avatarCenter.x,
              centerY: avatarCenter.y,
            }
          : null;
        const initialItemRevision = state.itemRevision;
        const initialCameraRevision = state.cameraRevision;
        applyMutation((instances) => {
          const withoutOnboardingTour = instances.filter(
            (instance) => defaultStickyNoteId(instance) !== "onboarding:tour",
          );
          const maxZ = withoutOnboardingTour.reduce(
            (currentMax, instance) => Math.max(currentMax, instance.z),
            0,
          );

          return [...withoutOnboardingTour, { ...onboardingTour, z: maxZ + 1 }];
        });

        if (expectedCamera) {
          get().saveCamera(expectedCamera);
        }
        await runtime.waitForPendingSaves();

        const latest = get();
        const itemSaved =
          latest.itemRevision !== initialItemRevision &&
          latest.instances.some(
            (instance) => instance.id === onboardingTour.id,
          );
        const cameraSaved =
          !expectedCamera ||
          (latest.cameraRevision !== initialCameraRevision &&
            latest.camera?.centerX === expectedCamera.centerX &&
            latest.camera.centerY === expectedCamera.centerY);
        return itemSaved && cameraSaved;
      },
      resetStarterTasks: async () => {
        const state = get();
        if (!canAcceptMutation(state)) return false;
        const initialItemRevision = state.itemRevision;
        const existingTaskNote = state.instances.find(
          (instance) => defaultStickyNoteId(instance) === STARTER_TASKS_NOTE_ID,
        );
        const existingProject = state.instances.find(
          (instance) =>
            instance.type === "onboardingProjectArtifact" ||
            instance.state?.onboardingStarterProject === true,
        );
        const withoutOwnedWidgets = state.instances.filter(
          (instance) =>
            instance.id !== existingTaskNote?.id &&
            instance.id !== existingProject?.id,
        );
        const nextInstances: WidgetInstance[] = [
          ...withoutOwnedWidgets,
          {
            id: existingTaskNote?.id ?? crypto.randomUUID(),
            type: "stickyNote",
            x: existingTaskNote?.x ?? -20,
            y: existingTaskNote?.y ?? -260,
            z: existingTaskNote?.z ?? withoutOwnedWidgets.length + 1,
            width: 256,
            height: 196,
            state: { noteId: STARTER_TASKS_NOTE_ID },
          },
          {
            id: existingProject?.id ?? crypto.randomUUID(),
            type: "onboardingProjectArtifact",
            x: existingProject?.x ?? 300,
            y: existingProject?.y ?? -260,
            z: existingProject?.z ?? withoutOwnedWidgets.length + 2,
            width: 400,
            height: 400,
            state: {
              projectId: STARTER_PROJECT_ID,
              onboardingStarterProject: true,
            },
          },
        ];
        set({ instances: nextInstances });
        runtime.enqueueSave(nextInstances);
        await runtime.waitForPendingSaves();
        const latest = get();
        return (
          latest.itemRevision !== initialItemRevision &&
          latest.instances.some(
            (instance) =>
              defaultStickyNoteId(instance) === STARTER_TASKS_NOTE_ID,
          ) &&
          latest.instances.some(
            (instance) =>
              instance.type === "onboardingProjectArtifact" &&
              instance.state?.projectId === STARTER_PROJECT_ID,
          )
        );
      },
      resetHomeForOnboarding: async () => {
        if (onboardingResetInFlight) {
          return { itemsConfirmed: false, cameraConfirmed: false };
        }
        onboardingResetInFlight = true;
        try {
          await runtime.waitForPendingSaves();
          const state = get();
          if (!canMutateWidgets(state) || state.itemRevision === null) {
            return { itemsConfirmed: false, cameraConfirmed: false };
          }
          const initialItemRevision = state.itemRevision;
          const initialCameraRevision = state.cameraRevision;

          resetStarterHomeArrangement();
          const nextInstances = createStarterHomeWidgets([]);

          const expectedCamera = state.camera
            ? {
                ...state.camera,
                centerX: 0,
                centerY: 40,
                zoomBps: 10_000,
              }
            : null;
          const previousState = {
            instances: state.instances,
            itemRevision: state.itemRevision,
            camera: state.camera,
            cameraRevision: state.cameraRevision,
            lastConfirmedLayout: state.lastConfirmedLayout,
            cleanUpSnapshot: state.cleanUpSnapshot,
          };
          persistCleanUpSnapshot(null);
          clearPendingCleanUpSaveOutcomes();
          set({ instances: nextInstances, cleanUpSnapshot: null });
          let itemResult: LayoutMutationResult;
          try {
            itemResult = await saveLayoutItems({
              layoutId: HOME_LAYOUT_ID,
              expectedRevision: initialItemRevision,
              replaceKinds: HOME_LAYOUT_REPLACE_KINDS,
              items: homeWidgetsToLayoutItems(nextInstances),
            });
            if (!itemResult.ok) {
              itemResult = await saveLayoutItems({
                layoutId: HOME_LAYOUT_ID,
                expectedRevision: itemResult.layout.itemRevision,
                replaceKinds: HOME_LAYOUT_REPLACE_KINDS,
                items: homeWidgetsToLayoutItems(nextInstances),
              });
            }
          } catch (error) {
            persistCleanUpSnapshot(previousState.cleanUpSnapshot);
            set(previousState);
            console.error("Failed to reset Home for onboarding:", error);
            return { itemsConfirmed: false, cameraConfirmed: false };
          }
          if (!itemResult.ok) {
            set({
              ...initialHomeWidgetState,
              ...itemResult.layout,
              instances: layoutItemsToHomeWidgets(itemResult.layout.items),
              loadStatus: "ready",
            });
            return { itemsConfirmed: false, cameraConfirmed: false };
          }
          set({
            instances: layoutItemsToHomeWidgets(itemResult.layout.items),
            itemRevision: itemResult.layout.itemRevision,
            lastConfirmedLayout: itemResult.layout,
          });
          if (expectedCamera) get().saveCamera(expectedCamera);
          await runtime.waitForPendingSaves();

          const latest = get();
          const confirmedIds = new Set(
            latest.instances.map((instance) => instance.id),
          );
          const itemsConfirmed =
            latest.itemRevision !== initialItemRevision &&
            latest.instances.length === nextInstances.length &&
            nextInstances.every((instance) => confirmedIds.has(instance.id));
          const cameraConfirmed =
            !expectedCamera ||
            (latest.cameraRevision !== initialCameraRevision &&
              latest.camera?.centerX === expectedCamera.centerX &&
              latest.camera.centerY === expectedCamera.centerY &&
              latest.camera.zoomBps === expectedCamera.zoomBps);
          if (itemsConfirmed && cameraConfirmed) {
            markStarterHomeArranged();
          } else if (itemsConfirmed && expectedCamera) {
            markStarterHomeCameraPending({
              expectedRevision: initialCameraRevision ?? 0,
              camera: expectedCamera,
            });
            toast.warning(i18n.t("home:widgetLayer.toasts.cameraSaveFailed"));
          }
          return { itemsConfirmed, cameraConfirmed };
        } finally {
          onboardingResetInFlight = false;
        }
      },
      reloadOnboardingTourForDev: () => {
        if (!import.meta.env.DEV) return;
        void get().resetOnboardingTour();
      },
      removeWidget: (id) => {
        clearStarterHomeLayoutEligibility();
        applyMutation((instances) => removeWidgetMutation(instances, id));
      },
      updateWidgetState: (id, state, bounds) => {
        applyMutation((instances) =>
          updateWidgetStateMutation(
            instances,
            id,
            state,
            resolvePlacementBounds(bounds),
          ),
        );
      },
      // Promotion rewrites a pinned draft chat's id in place, so a pinned chat
      // can be stored under two ids over its life. Pin telemetry resolves that
      // through the session store rather than watching this write; see
      // lib/chatPinIdentity.ts.
      replaceChatPinSessionId: (draftSessionId, backendSessionId) => {
        applyMutation((instances) => {
          let changed = false;
          const next = instances.map((instance) => {
            if (
              instance.type !== "chatPin" ||
              instance.state?.sessionId !== draftSessionId
            ) {
              return instance;
            }
            changed = true;
            return {
              ...instance,
              state: {
                ...instance.state,
                sessionId: backendSessionId,
              },
            };
          });

          return changed ? next : null;
        });
      },
      saveCamera: (camera) => {
        const state = get();
        if (!canAcceptMutation(state) || state.cameraRevision === null) {
          return;
        }

        set({ camera });
        runtime.enqueueCameraSave(camera);
      },
    };
  });

  return {
    store,
    reset: () => {
      runtime.__resetForTests__();
      clearPendingCleanUpSaveOutcomes();
      persistCleanUpSnapshot(null);
      store.setState({ cleanUpSnapshot: null });
    },
  };
}

const homeWidgetStore = createHomeWidgetStore();

export const useHomeWidgetStore = homeWidgetStore.store;

export function resetHomeWidgetStoreForTests(): void {
  homeWidgetStore.reset();
}
