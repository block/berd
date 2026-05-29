import type { LayoutConstraints } from "@/features/layout/api/layout";
import { resolveWidgetResize } from "../lib/homeWidgetResize";
import {
  clampToLayoutConstraints,
  GRID_SIZE,
  isLayoutConstraints,
  snapPoint,
  snapTo,
} from "../lib/snapToGrid";
import {
  clampWidgetSize,
  HOME_WIDGET_CATALOG,
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

const CLEAN_UP_GRID_GAP = 48;
const CLEAN_UP_GROUP_GAP = 96;
const CLEAN_UP_MAX_GROUP_ROWS = 4;

const WIDGET_TYPE_ORDER = new Map(
  HOME_WIDGET_CATALOG.map((entry, index) => [entry.id, index] as const),
);

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

function cleanUpStride(maxSize: number): number {
  return Math.ceil((maxSize + CLEAN_UP_GRID_GAP) / GRID_SIZE) * GRID_SIZE;
}

function cleanUpSize(type: string): WidgetSize {
  const entry = HOME_WIDGET_CATALOG_BY_ID[type];
  const size = clampWidgetSize(type, entry.defaultSize);

  return {
    width: Math.round(size.width),
    height: Math.round(size.height),
  };
}

function catalogSortOrder(instance: WidgetInstance): number {
  return WIDGET_TYPE_ORDER.get(instance.type) ?? Number.MAX_SAFE_INTEGER;
}

function sortedForCleanUp(instances: WidgetInstance[]): WidgetInstance[] {
  return [...instances].sort((left, right) => {
    const typeOrder = catalogSortOrder(left) - catalogSortOrder(right);
    if (typeOrder !== 0) {
      return typeOrder;
    }

    const zOrder = left.z - right.z;
    if (zOrder !== 0) {
      return zOrder;
    }

    return left.id.localeCompare(right.id);
  });
}

function widgetGroupBounds(instances: WidgetInstance[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  return instances.reduce(
    (bounds, instance) => {
      const size = widgetSizeForInstance(instance);
      return {
        minX: Math.min(bounds.minX, instance.x),
        minY: Math.min(bounds.minY, instance.y),
        maxX: Math.max(bounds.maxX, instance.x + size.width),
        maxY: Math.max(bounds.maxY, instance.y + size.height),
      };
    },
    {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    },
  );
}

function groupedForCleanUp(instances: WidgetInstance[]): WidgetInstance[][] {
  const groups = new Map<string, WidgetInstance[]>();

  for (const instance of sortedForCleanUp(instances)) {
    const group = groups.get(instance.type) ?? [];
    group.push(instance);
    groups.set(instance.type, group);
  }

  return [...groups.values()];
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

export function cleanUpWidgetsMutation(
  instances: WidgetInstance[],
  bounds?: LayoutConstraints,
): WidgetInstance[] | null {
  const cleanableInstances = instances.filter(
    (instance) => HOME_WIDGET_CATALOG_BY_ID[instance.type],
  );
  if (cleanableInstances.length === 0) {
    return null;
  }

  const groups = groupedForCleanUp(cleanableInstances);
  const currentBounds = widgetGroupBounds(cleanableInstances);
  const origin = snapPoint({
    x: currentBounds.minX,
    y: currentBounds.minY,
  });
  const nextById = new Map<string, WidgetInstance>();
  let changed = false;
  let groupX = origin.x;

  groups.forEach((group) => {
    const entry = HOME_WIDGET_CATALOG_BY_ID[group[0]?.type ?? ""];
    if (!entry) {
      return;
    }

    const normalizedSize = cleanUpSize(entry.id);
    const strideX = cleanUpStride(normalizedSize.width);
    const strideY = cleanUpStride(normalizedSize.height);
    const rows = Math.min(CLEAN_UP_MAX_GROUP_ROWS, group.length);
    const columns = Math.ceil(group.length / rows);

    group.forEach((instance, index) => {
      const position = {
        x: snapTo(groupX + Math.floor(index / rows) * strideX),
        y: snapTo(origin.y + (index % rows) * strideY),
      };
      const resolvedPosition = isLayoutConstraints(bounds)
        ? clampToLayoutConstraints(position, normalizedSize, bounds)
        : position;
      const next = {
        ...instance,
        ...resolvedPosition,
        z: nextById.size + 1,
        width: normalizedSize.width,
        height: normalizedSize.height,
      };

      if (
        instance.x !== next.x ||
        instance.y !== next.y ||
        instance.z !== next.z ||
        instance.width !== next.width ||
        instance.height !== next.height
      ) {
        changed = true;
      }

      nextById.set(instance.id, next);
    });

    groupX = snapTo(groupX + columns * strideX + CLEAN_UP_GROUP_GAP);
  });

  if (!changed) {
    return null;
  }

  return instances.map((instance) => nextById.get(instance.id) ?? instance);
}

export type WidgetLayoutSnapshotItem = Pick<
  WidgetInstance,
  "height" | "id" | "type" | "width" | "x" | "y" | "z"
>;

export function restoreWidgetsLayoutMutation(
  instances: WidgetInstance[],
  snapshot: WidgetLayoutSnapshotItem[],
): WidgetInstance[] | null {
  const snapshotById = new Map(snapshot.map((item) => [item.id, item]));
  let changed = false;
  const next = instances.map((instance) => {
    const item = snapshotById.get(instance.id);
    if (!item || item.type !== instance.type) {
      return instance;
    }

    const restored = {
      ...instance,
      x: item.x,
      y: item.y,
      z: item.z,
      ...(item.width === undefined ? {} : { width: item.width }),
      ...(item.height === undefined ? {} : { height: item.height }),
    };

    if (
      restored.x !== instance.x ||
      restored.y !== instance.y ||
      restored.z !== instance.z ||
      restored.width !== instance.width ||
      restored.height !== instance.height
    ) {
      changed = true;
    }

    return restored;
  });

  return changed ? next : null;
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
