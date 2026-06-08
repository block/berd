import { AgentPinWidget } from "./AgentPinWidget";
import { AutomationOutputWidget } from "./AutomationOutputWidget";
import { ChatPinWidget } from "./ChatPinWidget";
import { ClockWidget } from "./ClockWidget";
import { ProjectArtifactWidget } from "./ProjectArtifactWidget";
import { SkillPinWidget } from "./SkillPinWidget";
import { StickyNoteWidget } from "./StickyNoteWidget";
import { clockModeOf } from "./clockWidgetMode";
import type {
  WidgetCatalogEntry,
  WidgetCategory,
  WidgetInstance,
  WidgetSize,
  WidgetSizeBounds,
  WidgetSizeProfile,
} from "./types";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

const CLOCK_ANALOG_PROFILE: WidgetSizeProfile = {
  defaultSize: { width: 240, height: 240 },
  sizeBounds: {
    minWidth: 168,
    maxWidth: 360,
    minHeight: 168,
    maxHeight: 360,
    lockAspectRatio: true,
  },
};

// Landscape readout sized to hug the digits. Aspect 104/264 ≈ 0.394; bounds are
// exact 0.75x/1.5x multiples of the default so the locked ratio stays clean.
const CLOCK_DIGITAL_PROFILE: WidgetSizeProfile = {
  defaultSize: { width: 264, height: 104 },
  sizeBounds: {
    minWidth: 198,
    maxWidth: 396,
    minHeight: 78,
    maxHeight: 156,
    lockAspectRatio: true,
  },
};

export const HOME_WIDGET_CATALOG: WidgetCatalogEntry[] = [
  {
    id: "clock",
    category: "clock",
    labelKey: "widgets.clock.label",
    descriptionKey: "widgets.clock.description",
    defaultSize: CLOCK_ANALOG_PROFILE.defaultSize,
    sizeBounds: CLOCK_ANALOG_PROFILE.sizeBounds,
    resolveProfile: (instance) =>
      clockModeOf(instance) === "digital"
        ? CLOCK_DIGITAL_PROFILE
        : CLOCK_ANALOG_PROFILE,
    Component: ClockWidget,
  },
  {
    id: "stickyNote",
    category: "note",
    labelKey: "widgets.stickyNote.label",
    descriptionKey: "widgets.stickyNote.description",
    defaultSize: { width: 224, height: 196 },
    sizeBounds: {
      minWidth: 184,
      maxWidth: 360,
      minHeight: 156,
      maxHeight: 320,
    },
    Component: StickyNoteWidget,
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
    // Square hit target; label + resize handle overlay the cube bottom (see widget).
    defaultSize: { width: 200, height: 200 },
    sizeBounds: {
      minWidth: 140,
      maxWidth: 1000,
      minHeight: 140,
      maxHeight: 1000,
      lockAspectRatio: true,
    },
    resizeHandleClassName:
      "absolute right-[6%] bottom-[13%] z-30 hidden size-6 cursor-nwse-resize items-center justify-center rounded-full group-hover/widget:flex focus-visible:flex focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
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

export function widgetSizeProfile(instance: WidgetInstance): WidgetSizeProfile {
  const entry = HOME_WIDGET_CATALOG_BY_ID[instance.type];
  if (!entry) {
    return {
      defaultSize: { width: 1, height: 1 },
      sizeBounds: { minWidth: 1, maxWidth: 1, minHeight: 1, maxHeight: 1 },
    };
  }
  return (
    entry.resolveProfile?.(instance) ?? {
      defaultSize: entry.defaultSize,
      sizeBounds: entry.sizeBounds,
    }
  );
}

function clampSizeToProfile(
  profile: WidgetSizeProfile,
  size: WidgetSize,
): WidgetSize {
  const bounds = profile.sizeBounds;
  const requested = bounds.lockAspectRatio
    ? sizeWithLockedAspectRatio(profile.defaultSize, bounds, size)
    : size;

  return {
    width: clamp(requested.width, bounds.minWidth, bounds.maxWidth),
    height: clamp(requested.height, bounds.minHeight, bounds.maxHeight),
  };
}

export function widgetSizeForInstance(instance: WidgetInstance): WidgetSize {
  const profile = widgetSizeProfile(instance);
  return clampSizeToProfile(profile, {
    width: isFinitePositive(instance.width)
      ? instance.width
      : profile.defaultSize.width,
    height: isFinitePositive(instance.height)
      ? instance.height
      : profile.defaultSize.height,
  });
}

export function clampWidgetSize(type: string, size: WidgetSize): WidgetSize {
  const entry = HOME_WIDGET_CATALOG_BY_ID[type];
  if (!entry) {
    return size;
  }
  return clampSizeToProfile(
    { defaultSize: entry.defaultSize, sizeBounds: entry.sizeBounds },
    size,
  );
}

export function clampWidgetSizeForInstance(
  instance: WidgetInstance,
  size: WidgetSize,
): WidgetSize {
  return clampSizeToProfile(widgetSizeProfile(instance), size);
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
