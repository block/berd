import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { clampToBounds, snapPoint } from "../lib/snapToGrid";
import { HOME_WIDGET_CATALOG_BY_ID } from "../widgets/catalog";
import type { CanvasBounds, WidgetInstance } from "../widgets/types";

export const HOME_WIDGET_STORAGE_KEY = "goose-internal:home-widgets";

const BASELINE_CANVAS: CanvasBounds = { width: 1080, height: 760 };

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => {
      store.clear();
    },
    getItem: (key) => store.get(key) ?? null,
    key: (index) => Array.from(store.keys())[index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

function getPersistStorage(): Storage {
  if (typeof window === "undefined") {
    return createMemoryStorage();
  }
  const storage = window.localStorage;
  if (
    storage &&
    typeof storage.getItem === "function" &&
    typeof storage.setItem === "function" &&
    typeof storage.removeItem === "function"
  ) {
    return storage;
  }
  return createMemoryStorage();
}

function maxZ(instances: WidgetInstance[]): number {
  return instances.reduce((max, instance) => Math.max(max, instance.z), 0);
}

function resolvePosition(
  type: string,
  x: number,
  y: number,
  bounds?: CanvasBounds,
): { x: number; y: number } {
  const entry = HOME_WIDGET_CATALOG_BY_ID[type];
  const snapped = snapPoint({ x, y });
  if (!entry || !bounds) {
    return snapped;
  }
  return clampToBounds(snapped, entry.defaultSize, bounds);
}

function positionFromAnchor(
  type: string,
  anchorX: number,
  anchorY: number,
  bounds = BASELINE_CANVAS,
): { x: number; y: number } {
  const size = HOME_WIDGET_CATALOG_BY_ID[type]?.defaultSize ?? {
    width: 0,
    height: 0,
  };
  return resolvePosition(
    type,
    bounds.width * anchorX - size.width / 2,
    bounds.height * anchorY - size.height / 2,
    bounds,
  );
}

export function mergeFromStorage<T extends { instances: WidgetInstance[] }>(
  persistedState: unknown,
  currentState: T,
): T {
  const persisted = persistedState as { instances?: unknown } | undefined;
  if (!persisted || !Array.isArray(persisted.instances)) {
    return currentState;
  }
  const filtered = (persisted.instances as unknown[]).filter(
    (instance): instance is WidgetInstance => {
      if (
        typeof instance !== "object" ||
        instance === null ||
        !("type" in instance) ||
        typeof (instance as { type: unknown }).type !== "string"
      ) {
        return false;
      }
      return (
        HOME_WIDGET_CATALOG_BY_ID[(instance as { type: string }).type] !==
        undefined
      );
    },
  );
  return { ...currentState, instances: filtered };
}

export function createDefaultHomeWidgets(
  bounds = BASELINE_CANVAS,
): WidgetInstance[] {
  const clock = positionFromAnchor("clock", 0.83, 0.18, bounds);
  return [
    {
      id: "default-clock",
      type: "clock",
      x: clock.x,
      y: clock.y,
      z: 1,
    },
  ];
}

interface HomeWidgetStore {
  instances: WidgetInstance[];
  addWidget: (
    type: string,
    x: number,
    y: number,
    state?: Record<string, unknown>,
    bounds?: CanvasBounds,
  ) => void;
  moveWidget: (id: string, x: number, y: number, bounds?: CanvasBounds) => void;
  bumpZ: (id: string) => void;
  removeWidget: (id: string) => void;
  updateWidgetState: (id: string, state: Record<string, unknown>) => void;
}

export const useHomeWidgetStore = create<HomeWidgetStore>()(
  persist(
    (set) => ({
      instances: createDefaultHomeWidgets(),
      addWidget: (type, x, y, state, bounds) =>
        set((current) => {
          const entry = HOME_WIDGET_CATALOG_BY_ID[type];
          if (!entry) {
            return current;
          }
          const centered = resolvePosition(
            type,
            x - entry.defaultSize.width / 2,
            y - entry.defaultSize.height / 2,
            bounds,
          );
          return {
            instances: [
              ...current.instances,
              {
                id: crypto.randomUUID(),
                type,
                x: centered.x,
                y: centered.y,
                z: maxZ(current.instances) + 1,
                state,
              },
            ],
          };
        }),
      moveWidget: (id, x, y, bounds) =>
        set((current) => ({
          instances: current.instances.map((instance) =>
            instance.id === id
              ? {
                  ...instance,
                  ...resolvePosition(instance.type, x, y, bounds),
                }
              : instance,
          ),
        })),
      bumpZ: (id) =>
        set((current) => {
          const nextZ = maxZ(current.instances) + 1;
          return {
            instances: current.instances.map((instance) =>
              instance.id === id ? { ...instance, z: nextZ } : instance,
            ),
          };
        }),
      removeWidget: (id) =>
        set((current) => ({
          instances: current.instances.filter((instance) => instance.id !== id),
        })),
      updateWidgetState: (id, state) =>
        set((current) => ({
          instances: current.instances.map((instance) =>
            instance.id === id
              ? {
                  ...instance,
                  state: { ...(instance.state ?? {}), ...state },
                }
              : instance,
          ),
        })),
    }),
    {
      name: HOME_WIDGET_STORAGE_KEY,
      storage: createJSONStorage(getPersistStorage),
      version: 1,
      partialize: (state) => ({ instances: state.instances }),
      merge: mergeFromStorage,
    },
  ),
);
