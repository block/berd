import { toast } from "sonner";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import type {
  LayoutCamera,
  LayoutConstraints,
} from "@/features/layout/api/layout";
import { i18n } from "@/shared/i18n";
import { isLayoutConstraints } from "../lib/snapToGrid";
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
  ) => void;
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
  toggleCleanUpWidgets: (bounds?: WidgetPlacementInput) => void;
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
  }

  function handleItemSaveDiscarded(): void {
    applyPendingCleanUpSnapshot(cleanUpSnapshotOnSaveDiscarded);
    clearPendingCleanUpSaveOutcomes();
  }

  const runtime = createHomeWidgetRuntime({
    getState: () => store.getState(),
    onItemSaveConfirmed: handleItemSaveConfirmed,
    onItemSaveDiscarded: handleItemSaveDiscarded,
    setState: (patch) => store.setState(patch),
  });

  store = create<HomeWidgetStore>()((set, get) => {
    function applyMutation(
      mutate: (
        instances: HomeWidgetState["instances"],
      ) => HomeWidgetState["instances"] | null,
    ): void {
      const state = get();
      if (!canMutateWidgets(state)) {
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
      addWidget: (type, x, y, state, bounds) => {
        if (!HOME_WIDGET_CATALOG_BY_ID[type]) {
          return;
        }

        const current = get();
        if (!canMutateWidgets(current)) {
          return;
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
            return;
          }

          const added = withManualPlacement.find(
            (instance) => instance.id === id,
          );
          if (!added) {
            return;
          }

          const nextSnapshot = [
            ...current.cleanUpSnapshot,
            createAddedCleanUpSnapshotItem(added),
          ];
          const next =
            cleanUpWidgetsMutation(withManualPlacement, placementBounds) ??
            withManualPlacement;

          persistCleanUpSnapshot(nextSnapshot);
          setCleanUpSaveOutcomes({ discarded: current.cleanUpSnapshot });
          set({
            instances: next,
            cleanUpSnapshot: nextSnapshot,
          });
          runtime.enqueueSave(next);
          return;
        }

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
      },
      moveWidget: (id, x, y, bounds, options) => {
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
      toggleCleanUpWidgets: (bounds) => {
        const state = get();
        if (!canMutateWidgets(state)) {
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
      removeWidget: (id) => {
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
        if (state.loadStatus !== "ready" || state.cameraRevision === null) {
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
