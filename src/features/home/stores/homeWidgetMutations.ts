import { clampToBounds, snapPoint } from "../lib/snapToGrid";
import { HOME_WIDGET_CATALOG_BY_ID } from "../widgets/catalog";
import type { CanvasBounds, WidgetInstance } from "../widgets/types";

type AddWidgetOptions = {
  id: string;
  type: string;
  x: number;
  y: number;
  state?: Record<string, unknown>;
  bounds?: CanvasBounds;
};

function maxZ(instances: WidgetInstance[]): number {
  return instances.reduce((max, instance) => Math.max(max, instance.z), 0);
}

function normalizeZOrder(
  instances: WidgetInstance[],
  topWidgetId: string,
): WidgetInstance[] {
  return [...instances]
    .sort((left, right) => {
      if (left.id === topWidgetId) {
        return 1;
      }
      if (right.id === topWidgetId) {
        return -1;
      }
      return left.z - right.z;
    })
    .map((instance, index) => ({ ...instance, z: index + 1 }));
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

function isStateMergeNoop(
  currentState: Record<string, unknown> | undefined,
  nextPatch: Record<string, unknown>,
): boolean {
  const current = currentState ?? {};

  return Object.keys(nextPatch).every(
    (key) =>
      Object.hasOwn(current, key) && Object.is(current[key], nextPatch[key]),
  );
}

export function addWidgetMutation(
  instances: WidgetInstance[],
  { id, type, x, y, state, bounds }: AddWidgetOptions,
): WidgetInstance[] | null {
  const entry = HOME_WIDGET_CATALOG_BY_ID[type];
  if (!entry) {
    return null;
  }

  const centered = resolvePosition(
    type,
    x - entry.defaultSize.width / 2,
    y - entry.defaultSize.height / 2,
    bounds,
  );

  return [
    ...instances,
    {
      id,
      type,
      x: centered.x,
      y: centered.y,
      z: maxZ(instances) + 1,
      state,
    },
  ];
}

export function moveWidgetMutation(
  instances: WidgetInstance[],
  id: string,
  x: number,
  y: number,
  bounds?: CanvasBounds,
): WidgetInstance[] | null {
  const target = instances.find((instance) => instance.id === id);
  if (!target) {
    return null;
  }

  const position = resolvePosition(target.type, x, y, bounds);
  if (target.x === position.x && target.y === position.y) {
    return null;
  }

  return instances.map((instance) =>
    instance.id === id ? { ...instance, ...position } : instance,
  );
}

export function bumpZMutation(
  instances: WidgetInstance[],
  id: string,
): WidgetInstance[] | null {
  if (!instances.some((instance) => instance.id === id)) {
    return null;
  }

  const zById = new Map(
    normalizeZOrder(instances, id).map((instance) => [instance.id, instance.z]),
  );

  return instances.map((instance) => ({
    ...instance,
    z: zById.get(instance.id) ?? instance.z,
  }));
}

export function removeWidgetMutation(
  instances: WidgetInstance[],
  id: string,
): WidgetInstance[] | null {
  if (!instances.some((instance) => instance.id === id)) {
    return null;
  }

  return instances.filter((instance) => instance.id !== id);
}

export function updateWidgetStateMutation(
  instances: WidgetInstance[],
  id: string,
  state: Record<string, unknown>,
): WidgetInstance[] | null {
  const target = instances.find((instance) => instance.id === id);
  if (!target) {
    return null;
  }

  if (isStateMergeNoop(target.state, state)) {
    return null;
  }

  const nextState = { ...(target.state ?? {}), ...state };
  return instances.map((instance) =>
    instance.id === id ? { ...instance, state: nextState } : instance,
  );
}
