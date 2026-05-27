import { AgentPinWidget } from "./AgentPinWidget";
import { AutomationOutputWidget } from "./AutomationOutputWidget";
import { ChatPinWidget } from "./ChatPinWidget";
import { ClockWidget } from "./ClockWidget";
import { ProjectArtifactWidget } from "./ProjectArtifactWidget";
import { SkillPinWidget } from "./SkillPinWidget";
import type {
  WidgetCatalogEntry,
  WidgetCategory,
  WidgetInstance,
  WidgetSize,
  WidgetSizeBounds,
} from "./types";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export const HOME_WIDGET_CATALOG: WidgetCatalogEntry[] = [
  {
    id: "clock",
    category: "clock",
    labelKey: "widgets.clock.label",
    descriptionKey: "widgets.clock.description",
    defaultSize: { width: 240, height: 240 },
    sizeBounds: {
      minWidth: 168,
      maxWidth: 360,
      minHeight: 168,
      maxHeight: 360,
      lockAspectRatio: true,
    },
    Component: ClockWidget,
  },
  {
    id: "agentPin",
    category: "agent",
    labelKey: "widgets.agentPin.label",
    // Aspect-locked so the box matches the visible avatar+label shape; this
    // keeps the fieldset (click/drag surface) and the resize handle at the
    // edge of the visible content instead of floating in empty margin.
    // Ratio 220/200 = 1.10 — square avatar at full width + ~10% label band.
    defaultSize: { width: 200, height: 220 },
    sizeBounds: {
      minWidth: 120,
      maxWidth: 480,
      minHeight: 132,
      maxHeight: 528,
      lockAspectRatio: true,
    },
    Component: AgentPinWidget,
  },
  {
    id: "chatPin",
    category: "chat",
    labelKey: "widgets.chatPin.label",
    defaultSize: { width: 188, height: 80 },
    sizeBounds: {
      minWidth: 168,
      maxWidth: 480,
      minHeight: 72,
      maxHeight: 260,
    },
    Component: ChatPinWidget,
  },
  {
    id: "projectArtifactPin",
    category: "project",
    labelKey: "widgets.projectArtifactPin.label",
    descriptionKey: "widgets.projectArtifactPin.description",
    defaultSize: { width: 220, height: 220 },
    sizeBounds: {
      minWidth: 160,
      maxWidth: 480,
      minHeight: 160,
      maxHeight: 480,
      lockAspectRatio: true,
    },
    Component: ProjectArtifactWidget,
  },
  {
    id: "automationOutputPin",
    category: "automation",
    labelKey: "widgets.automationOutputPin.label",
    descriptionKey: "widgets.automationOutputPin.description",
    defaultSize: { width: 244, height: 213 },
    sizeBounds: {
      minWidth: 220,
      maxWidth: 560,
      minHeight: 176,
      maxHeight: 480,
    },
    Component: AutomationOutputWidget,
  },
  {
    id: "skillPin",
    category: "skill",
    labelKey: "widgets.skillPin.label",
    defaultSize: { width: 240, height: 56 },
    sizeBounds: {
      minWidth: 112,
      maxWidth: 440,
      minHeight: 40,
      maxHeight: 132,
    },
    Component: SkillPinWidget,
  },
];

export const HOME_WIDGET_CATALOG_BY_ID: Record<string, WidgetCatalogEntry> =
  Object.fromEntries(HOME_WIDGET_CATALOG.map((entry) => [entry.id, entry]));

export const HOME_WIDGET_CATEGORIES: WidgetCategory[] = [
  "clock",
  "agent",
  "chat",
  "project",
  "automation",
  "skill",
];

export function widgetSizeForInstance(instance: WidgetInstance): WidgetSize {
  const entry = HOME_WIDGET_CATALOG_BY_ID[instance.type];
  const defaultSize = entry?.defaultSize ?? { width: 1, height: 1 };

  return clampWidgetSize(instance.type, {
    width: isFinitePositive(instance.width)
      ? instance.width
      : defaultSize.width,
    height: isFinitePositive(instance.height)
      ? instance.height
      : defaultSize.height,
  });
}

export function clampWidgetSize(type: string, size: WidgetSize): WidgetSize {
  const entry = HOME_WIDGET_CATALOG_BY_ID[type];
  if (!entry) {
    return size;
  }

  const bounds = entry.sizeBounds;
  const requested = bounds.lockAspectRatio
    ? sizeWithLockedAspectRatio(entry.defaultSize, bounds, size)
    : size;

  return {
    width: clamp(requested.width, bounds.minWidth, bounds.maxWidth),
    height: clamp(requested.height, bounds.minHeight, bounds.maxHeight),
  };
}

function sizeWithLockedAspectRatio(
  defaultSize: WidgetSize,
  bounds: WidgetSizeBounds,
  size: WidgetSize,
): WidgetSize {
  const aspectRatio = defaultSize.height / defaultSize.width;
  const width = Math.max(size.width, 1);
  const clampedWidth = clamp(width, bounds.minWidth, bounds.maxWidth);

  return {
    width: clampedWidth,
    height: clamp(
      clampedWidth * aspectRatio,
      bounds.minHeight,
      bounds.maxHeight,
    ),
  };
}
