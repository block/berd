import type { LayoutItem, LayoutItemKind } from "@/features/layout/api/layout";
import {
  clampWidgetSize,
  clampWidgetSizeForInstance,
  HOME_WIDGET_CATALOG_BY_ID,
  widgetSizeForInstance,
} from "../widgets/catalog";
import { clockModeOf } from "../widgets/clockWidgetMode";
import type { CanvasBounds, WidgetInstance } from "../widgets/types";
import { clampToBounds, snapPoint } from "./snapToGrid";

export const HOME_LAYOUT_REPLACE_KINDS = [
  "clock",
  "stickyNote",
  "persona",
  "session",
  "project",
  "automation",
  "skill",
] as const satisfies LayoutItemKind[];

type HomeLayoutKind = (typeof HOME_LAYOUT_REPLACE_KINDS)[number];

const DEFAULT_CANVAS: CanvasBounds = { width: 1080, height: 760 };
const DEFAULT_CLOCK_ANCHOR = { x: 0.83, y: 0.18 };

const KIND_TO_WIDGET_TYPE = {
  clock: "clock",
  stickyNote: "stickyNote",
  persona: "agentPin",
  session: "chatPin",
  project: "projectArtifactPin",
  automation: "automationOutputPin",
  skill: "skillPin",
} as const satisfies Record<HomeLayoutKind, string>;

const WIDGET_TYPE_TO_KIND: Partial<Record<string, HomeLayoutKind>> = {
  clock: "clock",
  stickyNote: "stickyNote",
  agentPin: "persona",
  chatPin: "session",
  projectArtifactPin: "project",
  automationOutputPin: "automation",
  skillPin: "skill",
};

function isHomeLayoutKind(kind: LayoutItemKind): kind is HomeLayoutKind {
  switch (kind) {
    case "clock":
    case "stickyNote":
    case "persona":
    case "session":
    case "project":
    case "automation":
    case "skill":
      return true;
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

const DIGITAL_CLOCK_TARGET_SUFFIX = ":digital";
const SIZE_BY_PROFILE_STATE_KEY = "__sizeByProfile";

function isWidgetSize(
  value: unknown,
): value is { width: number; height: number } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const size = value as Record<string, unknown>;
  return (
    typeof size.width === "number" &&
    Number.isFinite(size.width) &&
    size.width > 0 &&
    typeof size.height === "number" &&
    Number.isFinite(size.height) &&
    size.height > 0
  );
}

function readSizeByProfile(
  state: Record<string, unknown> | null | undefined,
): Record<string, { width: number; height: number }> | undefined {
  const raw = state?.[SIZE_BY_PROFILE_STATE_KEY];
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }

  const entries = Object.entries(raw).filter(
    (entry): entry is [string, { width: number; height: number }] =>
      typeof entry[0] === "string" && isWidgetSize(entry[1]),
  );
  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

function clockStateFromTarget(
  targetId: string,
): Record<string, unknown> | undefined {
  return targetId.endsWith(DIGITAL_CLOCK_TARGET_SUFFIX)
    ? { mode: "digital" }
    : undefined;
}

function mergeState(
  ...states: Array<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined {
  const merged = Object.assign({}, ...states.filter(Boolean));
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function persistedClockStateFromItem(
  item: LayoutItem,
): Record<string, unknown> | undefined {
  const sizeByProfile = readSizeByProfile(item.widgetState);
  return sizeByProfile
    ? { [SIZE_BY_PROFILE_STATE_KEY]: sizeByProfile }
    : undefined;
}

function stateForItem(item: LayoutItem): Record<string, unknown> | undefined {
  if (item.kind !== "clock" && isSyntheticTarget(item.targetId)) {
    return undefined;
  }

  switch (item.kind) {
    case "persona":
      return { agentId: item.targetId };
    case "session":
      return { sessionId: item.targetId };
    case "project":
      return { projectId: item.targetId };
    case "automation":
      return { automationId: item.targetId };
    case "clock":
      return mergeState(
        clockStateFromTarget(item.targetId),
        persistedClockStateFromItem(item),
      );
    case "stickyNote":
      return { noteId: item.targetId };
    case "skill":
      return { skillId: item.targetId };
    default: {
      const exhaustive: never = item.kind;
      return exhaustive;
    }
  }
}

function widgetStateForLayoutItem(
  instance: WidgetInstance,
  kind: HomeLayoutKind,
): Record<string, unknown> | undefined {
  if (kind !== "clock") {
    return undefined;
  }

  const sizeByProfile = readSizeByProfile(instance.state);
  return sizeByProfile
    ? { [SIZE_BY_PROFILE_STATE_KEY]: sizeByProfile }
    : undefined;
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
      return clockModeOf(instance) === "digital"
        ? `${syntheticTarget(instance.id)}${DIGITAL_CLOCK_TARGET_SUFFIX}`
        : syntheticTarget(instance.id);
    case "stickyNote":
      return nonEmptyStateString(state.noteId) ?? syntheticTarget(instance.id);
    case "persona":
      return nonEmptyStateString(state.agentId) ?? syntheticTarget(instance.id);
    case "session":
      return (
        nonEmptyStateString(state.sessionId) ?? syntheticTarget(instance.id)
      );
    case "project":
      return (
        nonEmptyStateString(state.projectId) ?? syntheticTarget(instance.id)
      );
    case "automation":
      return (
        nonEmptyStateString(state.automationId) ?? syntheticTarget(instance.id)
      );
    case "skill":
      return nonEmptyStateString(state.skillId) ?? syntheticTarget(instance.id);
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
    const widgetSize = clampWidgetSizeForInstance(
      {
        id: item.id,
        type,
        x: 0,
        y: 0,
        z: item.zIndex,
        width: item.width,
        height: item.height,
        ...(state ? { state } : {}),
      },
      { width: item.width, height: item.height },
    );
    return [
      {
        id: item.id,
        type,
        x: item.centerX - widgetSize.width / 2,
        y: item.centerY - widgetSize.height / 2,
        z: item.zIndex,
        width: widgetSize.width,
        height: widgetSize.height,
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
    if (!HOME_WIDGET_CATALOG_BY_ID[instance.type]?.defaultSize) {
      return [];
    }
    const size = widgetSizeForInstance(instance);
    const widgetState = widgetStateForLayoutItem(instance, kind);
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
        ...(widgetState ? { widgetState } : {}),
      },
    ];
  });
}

export function createDefaultClockWidget(
  bounds: CanvasBounds = DEFAULT_CANVAS,
): WidgetInstance {
  const type = "clock";
  const size = clampWidgetSize(
    type,
    HOME_WIDGET_CATALOG_BY_ID[type].defaultSize,
  );
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
    width: size.width,
    height: size.height,
  };
}

export function createDefaultClockLayoutItem(
  bounds?: CanvasBounds,
): LayoutItem {
  const [item] = homeWidgetsToLayoutItems([createDefaultClockWidget(bounds)]);
  return item;
}

export function createDefaultStickyNoteWidgets(): WidgetInstance[] {
  return [
    {
      id: crypto.randomUUID(),
      type: "stickyNote",
      x: -360,
      y: -240,
      z: 1,
      width: 224,
      height: 196,
      state: { noteId: "onboarding:welcome" },
    },
    {
      id: crypto.randomUUID(),
      type: "stickyNote",
      x: -96,
      y: -240,
      z: 2,
      width: 224,
      height: 196,
      state: { noteId: "onboarding:start-project" },
    },
    {
      id: crypto.randomUUID(),
      type: "stickyNote",
      x: 168,
      y: -240,
      z: 3,
      width: 224,
      height: 196,
      state: { noteId: "onboarding:build-agent" },
    },
    {
      id: crypto.randomUUID(),
      type: "stickyNote",
      x: -360,
      y: 0,
      z: 4,
      width: 224,
      height: 196,
      state: { noteId: "onboarding:reuse-workflows" },
    },
    {
      id: crypto.randomUUID(),
      type: "stickyNote",
      x: -96,
      y: 0,
      z: 5,
      width: 224,
      height: 196,
      state: { noteId: "onboarding:manage-automations" },
    },
    {
      id: crypto.randomUUID(),
      type: "stickyNote",
      x: 168,
      y: 0,
      z: 6,
      width: 224,
      height: 196,
      state: { noteId: "onboarding:shape-home" },
    },
  ];
}

export function defaultStickyNoteId(instance: WidgetInstance): string | null {
  if (instance.type !== "stickyNote") {
    return null;
  }

  const noteId = instance.state?.noteId;
  return typeof noteId === "string" && noteId.trim() ? noteId.trim() : null;
}

export function missingDefaultStickyNoteWidgets(
  instances: WidgetInstance[],
): WidgetInstance[] {
  const existingNoteIds = new Set(
    instances.flatMap((instance) => {
      const noteId = defaultStickyNoteId(instance);
      return noteId ? [noteId] : [];
    }),
  );

  return createDefaultStickyNoteWidgets().filter((instance) => {
    const noteId = defaultStickyNoteId(instance);
    return noteId !== null && !existingNoteIds.has(noteId);
  });
}

export function createDefaultHomeWidgets(
  bounds: CanvasBounds = DEFAULT_CANVAS,
): WidgetInstance[] {
  return [
    ...createDefaultStickyNoteWidgets(),
    {
      ...createDefaultClockWidget(bounds),
      z: 7,
    },
  ];
}

export function createDefaultHomeLayoutItems(
  bounds?: CanvasBounds,
): LayoutItem[] {
  return homeWidgetsToLayoutItems(createDefaultHomeWidgets(bounds));
}
