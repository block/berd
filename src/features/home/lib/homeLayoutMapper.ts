import type { LayoutItem, LayoutItemKind } from "@/features/layout/api/layout";
import { HOME_WIDGET_CATALOG_BY_ID } from "../widgets/catalog";
import type { CanvasBounds, WidgetInstance } from "../widgets/types";
import { clampToBounds, snapPoint } from "./snapToGrid";

export const HOME_LAYOUT_REPLACE_KINDS = [
  "clock",
  "persona",
  "session",
  "automation",
] as const satisfies LayoutItemKind[];

type HomeLayoutKind = (typeof HOME_LAYOUT_REPLACE_KINDS)[number];

const DEFAULT_CANVAS: CanvasBounds = { width: 1080, height: 760 };
const DEFAULT_CLOCK_ANCHOR = { x: 0.83, y: 0.18 };

const KIND_TO_WIDGET_TYPE = {
  clock: "clock",
  persona: "agentPin",
  session: "chatPin",
  automation: "automationOutputPin",
} as const satisfies Record<HomeLayoutKind, string>;

const WIDGET_TYPE_TO_KIND: Partial<Record<string, HomeLayoutKind>> = {
  clock: "clock",
  agentPin: "persona",
  chatPin: "session",
  automationOutputPin: "automation",
};

function isHomeLayoutKind(kind: LayoutItemKind): kind is HomeLayoutKind {
  switch (kind) {
    case "clock":
    case "persona":
    case "session":
    case "automation":
      return true;
    case "project":
      return false;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function isSyntheticTarget(targetId: string): boolean {
  return targetId.startsWith("widget:");
}

function syntheticTarget(instanceId: string): string {
  return `widget:${instanceId}`;
}

function stateForItem(item: LayoutItem): Record<string, unknown> | undefined {
  if (isSyntheticTarget(item.targetId)) {
    return undefined;
  }

  switch (item.kind) {
    case "persona":
      return { agentId: item.targetId };
    case "session":
      return { sessionId: item.targetId };
    case "automation":
      return { automationId: item.targetId };
    case "clock":
      return undefined;
    case "project":
      return undefined;
    default: {
      const exhaustive: never = item.kind;
      return exhaustive;
    }
  }
}

function nonEmptyStateString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function targetIdForWidget(
  instance: WidgetInstance,
  kind: HomeLayoutKind,
): string {
  const state = instance.state ?? {};
  switch (kind) {
    case "clock":
      return syntheticTarget(instance.id);
    case "persona":
      return nonEmptyStateString(state.agentId) ?? syntheticTarget(instance.id);
    case "session":
      return (
        nonEmptyStateString(state.sessionId) ?? syntheticTarget(instance.id)
      );
    case "automation":
      return (
        nonEmptyStateString(state.automationId) ?? syntheticTarget(instance.id)
      );
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export function layoutItemsToHomeWidgets(
  items: LayoutItem[],
): WidgetInstance[] {
  return items.flatMap((item) => {
    if (!isHomeLayoutKind(item.kind)) {
      return [];
    }
    const type = KIND_TO_WIDGET_TYPE[item.kind];
    const size = HOME_WIDGET_CATALOG_BY_ID[type]?.defaultSize;
    if (!size) {
      return [];
    }
    const state = stateForItem(item);
    return [
      {
        id: item.id,
        type,
        x: item.centerX - size.width / 2,
        y: item.centerY - size.height / 2,
        z: item.zIndex,
        ...(state ? { state } : {}),
      },
    ];
  });
}

export function homeWidgetsToLayoutItems(
  instances: WidgetInstance[],
): LayoutItem[] {
  return instances.flatMap((instance) => {
    const kind = WIDGET_TYPE_TO_KIND[instance.type];
    if (!kind) {
      return [];
    }
    const size = HOME_WIDGET_CATALOG_BY_ID[instance.type]?.defaultSize;
    if (!size) {
      return [];
    }
    return [
      {
        id: instance.id,
        kind,
        targetId: targetIdForWidget(instance, kind),
        centerX: instance.x + size.width / 2,
        centerY: instance.y + size.height / 2,
        width: size.width,
        height: size.height,
        zIndex: instance.z,
        titleOverride: null,
      },
    ];
  });
}

export function createDefaultClockWidget(
  bounds: CanvasBounds = DEFAULT_CANVAS,
): WidgetInstance {
  const type = "clock";
  const size = HOME_WIDGET_CATALOG_BY_ID[type].defaultSize;
  const snapped = snapPoint({
    x: bounds.width * DEFAULT_CLOCK_ANCHOR.x - size.width / 2,
    y: bounds.height * DEFAULT_CLOCK_ANCHOR.y - size.height / 2,
  });
  const position = clampToBounds(snapped, size, bounds);

  return {
    id: crypto.randomUUID(),
    type,
    x: position.x,
    y: position.y,
    z: 1,
  };
}

export function createDefaultClockLayoutItem(
  bounds?: CanvasBounds,
): LayoutItem {
  const [item] = homeWidgetsToLayoutItems([createDefaultClockWidget(bounds)]);
  return item;
}
