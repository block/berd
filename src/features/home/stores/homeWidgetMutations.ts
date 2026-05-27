import type { LayoutConstraints } from "@/features/layout/api/layout";
import { resolveWidgetResize } from "../lib/homeWidgetResize";
import {
  clampToLayoutConstraints,
  isLayoutConstraints,
  snapPoint,
} from "../lib/snapToGrid";
import {
  clampWidgetSize,
  HOME_WIDGET_CATALOG_BY_ID,
  widgetSizeForInstance,
} from "../widgets/catalog";
import type {
  MoveWidgetOptions,
  WidgetInstance,
  WidgetSize,
} from "../widgets/types";

type AddWidgetOptions = {
  id: string;
  type: string;
  x: number;
  y: number;
  state?: Record<string, unknown>;
  bounds?: LayoutConstraints;
};

function maxZ(instances: WidgetInstance[]): number {
  return instances.reduce((max, instance) => Math.max(max, instance.z), 0);
}

function normalizedZById(
  instances: WidgetInstance[],
  topWidgetId: string,
): Map<string, number> {
  return new Map(
    [...instances]
      .sort((left, right) => {
        if (left.id === topWidgetId) {
          return 1;
        }
        if (right.id === topWidgetId) {
          return -1;
        }
        return left.z - right.z;
      })
      .map((instance, index) => [instance.id, index + 1] as const),
  );
}

function applyNormalizedZOrder(
  instances: WidgetInstance[],
  zById: Map<string, number>,
): WidgetInstance[] {
  return instances.map((instance) => ({
    ...instance,
    z: zById.get(instance.id) ?? instance.z,
  }));
}

function resolvePosition(
  type: string,
  x: number,
  y: number,
  size: WidgetSize,
  bounds?: LayoutConstraints,
): { x: number; y: number } {
  const entry = HOME_WIDGET_CATALOG_BY_ID[type];
  const snapped = snapPoint({ x, y });
  if (!entry || !isLayoutConstraints(bounds)) {
    return snapped;
  }
  return clampToLayoutConstraints(snapped, size, bounds);
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
  const size = clampWidgetSize(type, entry.defaultSize);

  const centered = resolvePosition(
    type,
    x - size.width / 2,
    y - size.height / 2,
    size,
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
      width: size.width,
      height: size.height,
      state,
    },
  ];
}

export function moveWidgetMutation(
  instances: WidgetInstance[],
  id: string,
  x: number,
  y: number,
  bounds?: LayoutConstraints,
  options: MoveWidgetOptions = {},
): WidgetInstance[] | null {
  const target = instances.find((instance) => instance.id === id);
  if (!target) {
    return null;
  }

  const position = resolvePosition(
    target.type,
    x,
    y,
    widgetSizeForInstance(target),
    bounds,
  );
  const moved = target.x !== position.x || target.y !== position.y;
  const nextInstances = moved
    ? instances.map((instance) =>
        instance.id === id ? { ...instance, ...position } : instance,
      )
    : instances;

  if (!options.bringToFront) {
    return moved ? nextInstances : null;
  }

  const zById = normalizedZById(nextInstances, id);
  const next = applyNormalizedZOrder(nextInstances, zById);
  if (
    !moved &&
    next.every((instance, index) => instance.z === nextInstances[index]?.z)
  ) {
    return null;
  }

  return next;
}

export function resizeWidgetMutation(
  instances: WidgetInstance[],
  id: string,
  width: number,
  height: number,
  bounds?: LayoutConstraints,
  options: MoveWidgetOptions = {},
): WidgetInstance[] | null {
  const target = instances.find((instance) => instance.id === id);
  if (!target) {
    return null;
  }

  const resolved = resolveWidgetResize({
    instance: target,
    requestedSize: { width, height },
    bounds,
  });
  const resized =
    target.width !== resolved.width ||
    target.height !== resolved.height ||
    target.x !== resolved.x ||
    target.y !== resolved.y;
  const nextInstances = resized
    ? instances.map((instance) =>
        instance.id === id ? { ...instance, ...resolved } : instance,
      )
    : instances;

  if (!options.bringToFront) {
    return resized ? nextInstances : null;
  }

  const zById = normalizedZById(nextInstances, id);
  const next = applyNormalizedZOrder(nextInstances, zById);
  if (
    !resized &&
    next.every((instance, index) => instance.z === nextInstances[index]?.z)
  ) {
    return null;
  }

  return next;
}

export function bumpZMutation(
  instances: WidgetInstance[],
  id: string,
): WidgetInstance[] | null {
  if (!instances.some((instance) => instance.id === id)) {
    return null;
  }

  return applyNormalizedZOrder(instances, normalizedZById(instances, id));
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
