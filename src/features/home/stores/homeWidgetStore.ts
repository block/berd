import { toast } from "sonner";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import type {
  LayoutCamera,
  LayoutConstraints,
} from "@/features/layout/api/layout";
import { i18n } from "@/shared/i18n";
import { isLayoutConstraints } from "../lib/snapToGrid";
import { HOME_WIDGET_CATALOG_BY_ID } from "../widgets/catalog";
import type { CanvasBounds, MoveWidgetOptions } from "../widgets/types";
import {
  addWidgetMutation,
  bumpZMutation,
  moveWidgetMutation,
  removeWidgetMutation,
  resizeWidgetMutation,
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

function resolvePlacementBounds(
  bounds?: WidgetPlacementInput,
): LayoutConstraints | undefined {
  return isLayoutConstraints(bounds) ? bounds : undefined;
}

interface HomeWidgetStore extends HomeWidgetState {
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
  removeWidget: (id: string) => void;
  updateWidgetState: (id: string, state: Record<string, unknown>) => void;
  saveCamera: (camera: LayoutCamera) => void;
}

function createHomeWidgetStore() {
  let store!: UseBoundStore<StoreApi<HomeWidgetStore>>;
  const runtime = createHomeWidgetRuntime({
    getState: () => store.getState(),
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

      set({ instances: next });
      runtime.enqueueSave(next);
    }

    return {
      ...initialHomeWidgetState,
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
        applyMutation((instances) => {
          if (!HOME_WIDGET_CATALOG_BY_ID[type]) {
            return null;
          }

          return addWidgetMutation(instances, {
            id: crypto.randomUUID(),
            type,
            x,
            y,
            state,
            bounds: resolvePlacementBounds(bounds),
          });
        });
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
      removeWidget: (id) => {
        applyMutation((instances) => removeWidgetMutation(instances, id));
      },
      updateWidgetState: (id, state) => {
        applyMutation((instances) =>
          updateWidgetStateMutation(instances, id, state),
        );
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
    reset: () => runtime.__resetForTests__(),
  };
}

const homeWidgetStore = createHomeWidgetStore();

export const useHomeWidgetStore = homeWidgetStore.store;

export function resetHomeWidgetStoreForTests(): void {
  homeWidgetStore.reset();
}
