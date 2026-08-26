import { AgentPinWidget } from "./AgentPinWidget";
import { AutomationOutputWidget } from "./AutomationOutputWidget";
import { ChatPinWidget } from "./ChatPinWidget";
import { ChecklistWidget } from "./ChecklistWidget";
import { ClockWidget } from "./ClockWidget";
import { OnboardingTourWidget } from "./OnboardingTourWidget";
import { photoAspectRatioOf, photoShapeOf, PhotoWidget } from "./PhotoWidget";
import { ProjectArtifactWidget } from "./ProjectArtifactWidget";
import { PromptPinWidget } from "./PromptPinWidget";
import { promptPinMode } from "./promptPinMode";
import { SkillPinWidget } from "./SkillPinWidget";
import { StickyNoteWidget } from "./StickyNoteWidget";
import { LABEL_DEFAULT_SIZE } from "./labelWidgetModel";
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

const ONBOARDING_TOUR_AVATAR_PROFILE: WidgetSizeProfile = {
  defaultSize: { width: 160, height: 160 },
  sizeBounds: {
    minWidth: 160,
    maxWidth: 160,
    minHeight: 160,
    maxHeight: 160,
    lockAspectRatio: true,
  },
};

// One 20px content row (14px title text) plus the 16px padding the chat pin
// card uses, so the two pins read as the same family on the canvas.
const PROMPT_PIN_READY_HEIGHT = 52;

const CLOCK_ANALOG_PROFILE: WidgetSizeProfile = {
  defaultSize: { width: 156, height: 156 },
  sizeBounds: {
    minWidth: 156,
    maxWidth: 360,
    minHeight: 156,
    maxHeight: 360,
    lockAspectRatio: true,
  },
};

// Landscape readout uses rounded dimensions near 85% of its former default
// footprint so cleanup and persistence remain stable.
const CLOCK_DIGITAL_PROFILE: WidgetSizeProfile = {
  defaultSize: { width: 224, height: 88 },
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
    id: "onboardingTour",
    category: "agent",
    labelKey: "onboarding.callout.action",
    defaultSize: { width: 448, height: 180 },
    sizeBounds: {
      // The avatar + chat bubble require the full default footprint. Keep the
      // resize affordance for enlarging Berdy without allowing a smaller frame
      // to clip the interactive chat content.
      minWidth: 448,
      maxWidth: 672,
      minHeight: 180,
      maxHeight: 270,
      lockAspectRatio: true,
    },
    resolveProfile: (instance) =>
      instance.state?.welcomeDismissed === true
        ? ONBOARDING_TOUR_AVATAR_PROFILE
        : {
            defaultSize: { width: 448, height: 180 },
            sizeBounds: {
              minWidth: 448,
              maxWidth: 672,
              minHeight: 180,
              maxHeight: 270,
              lockAspectRatio: true,
            },
            contentOffset: (size) => ({
              x: 0,
              y: (size.height - 160) / 2,
            }),
          },
    preservePositionOnProfileChange: true,
    Component: OnboardingTourWidget,
  },
  {
    id: "clock",
    category: "clock",
    labelKey: "widgets.clock.label",
    descriptionKey: "widgets.clock.description",
    defaultSize: CLOCK_ANALOG_PROFILE.defaultSize,
    sizeBounds: CLOCK_ANALOG_PROFILE.sizeBounds,
    preserveSizeOnCleanUp: true,
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
    resolveProfile: (instance) => {
      if (instance.state?.noteId === "onboarding:starter-tasks") {
        return {
          defaultSize: { width: 224, height: 196 },
          sizeBounds: {
            minWidth: 224,
            maxWidth: 360,
            minHeight: 156,
            maxHeight: 320,
          },
        };
      }
      return {
        defaultSize: { width: 224, height: 196 },
        sizeBounds: {
          minWidth: 184,
          maxWidth: 360,
          minHeight: 156,
          maxHeight: 320,
        },
      };
    },
    Component: StickyNoteWidget,
  },
  {
    id: "label",
    category: "note",
    labelKey: "widgets.label.label",
    descriptionKey: "widgets.label.description",
    defaultSize: LABEL_DEFAULT_SIZE,
    sizeBounds: {
      minWidth: LABEL_DEFAULT_SIZE.width,
      maxWidth: LABEL_DEFAULT_SIZE.width,
      minHeight: LABEL_DEFAULT_SIZE.height,
      maxHeight: LABEL_DEFAULT_SIZE.height,
    },
    hideResizeHandle: true,
    Component: StickyNoteWidget,
  },
  {
    id: "checklist",
    category: "checklist",
    labelKey: "widgets.checklist.label",
    descriptionKey: "widgets.checklist.description",
    defaultSize: { width: 240, height: 248 },
    sizeBounds: {
      minWidth: 200,
      maxWidth: 420,
      minHeight: 160,
      maxHeight: 560,
    },
    Component: ChecklistWidget,
  },
  {
    id: "photo",
    category: "photo",
    labelKey: "widgets.photo.label",
    descriptionKey: "widgets.photo.description",
    defaultSize: { width: 280, height: 210 },
    sizeBounds: {
      minWidth: 168,
      maxWidth: 720,
      minHeight: 168,
      maxHeight: 720,
    },
    preserveWidthOnProfileChange: true,
    preserveSizeOnCleanUp: true,
    resolveProfile: (instance) => {
      const shape = photoShapeOf(instance.state);
      if (shape === "original") {
        const aspectRatio = photoAspectRatioOf(instance.state);
        return {
          defaultSize: { width: 280, height: 280 / aspectRatio },
          sizeBounds: {
            minWidth: 96,
            maxWidth: 1440,
            minHeight: 48,
            maxHeight: 1440,
            lockAspectRatio: true,
          },
        };
      }
      return {
        defaultSize: { width: 240, height: 240 },
        sizeBounds: {
          minWidth: 96,
          maxWidth: 1440,
          minHeight: 96,
          maxHeight: 1440,
          lockAspectRatio: true,
        },
      };
    },
    Component: PhotoWidget,
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
    resolveProfile: (instance) =>
      instance.state?.presentation === "expanded"
        ? {
            defaultSize: { width: 480, height: 560 },
            sizeBounds: {
              minWidth: 360,
              maxWidth: 760,
              minHeight: 360,
              maxHeight: 840,
            },
          }
        : {
            defaultSize: { width: 188, height: 80 },
            sizeBounds: {
              minWidth: 168,
              maxWidth: 480,
              minHeight: 72,
              maxHeight: 260,
            },
          },
    preservePositionOnProfileChange: true,
    Component: ChatPinWidget,
  },
  {
    id: "onboardingProjectArtifact",
    category: "project",
    labelKey: "widgets.projectArtifactPin.label",
    descriptionKey: "widgets.projectArtifactPin.description",
    defaultSize: { width: 440, height: 440 },
    preserveSizeOnCleanUp: true,
    sizeBounds: {
      minWidth: 140,
      maxWidth: 1000,
      minHeight: 140,
      maxHeight: 1000,
      lockAspectRatio: true,
    },
    resizeHandleClassName:
      "absolute right-[6%] bottom-[13%] z-30 hidden size-6 cursor-nwse-resize items-center justify-center rounded-full group-hover/widget:flex focus-visible:flex focus-visible:ring-2 focus-visible:ring-ring",
    Component: ProjectArtifactWidget,
  },
  {
    id: "projectArtifactPin",
    category: "project",
    labelKey: "widgets.projectArtifactPin.label",
    descriptionKey: "widgets.projectArtifactPin.description",
    // Square hit target; label + resize handle overlay the cube bottom (see widget).
    defaultSize: { width: 220, height: 220 },
    preserveSizeOnCleanUp: true,
    sizeBounds: {
      minWidth: 140,
      maxWidth: 1000,
      minHeight: 140,
      maxHeight: 1000,
      lockAspectRatio: true,
    },
    resolveProfile: (instance) =>
      instance.state?.onboardingStarterProject === true ||
      instance.state?.projectId === "onboarding-starter-project"
        ? {
            defaultSize: { width: 440, height: 440 },
            sizeBounds: {
              minWidth: 140,
              maxWidth: 1000,
              minHeight: 140,
              maxHeight: 1000,
              lockAspectRatio: true,
            },
          }
        : {
            defaultSize: { width: 220, height: 220 },
            sizeBounds: {
              minWidth: 140,
              maxWidth: 1000,
              minHeight: 140,
              maxHeight: 1000,
              lockAspectRatio: true,
            },
          },
    resizeHandleClassName:
      "absolute right-[6%] bottom-[13%] z-30 hidden size-6 cursor-nwse-resize items-center justify-center rounded-full group-hover/widget:flex focus-visible:flex focus-visible:ring-2 focus-visible:ring-ring",
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
  {
    id: "promptPin",
    category: "prompt",
    labelKey: "widgets.promptPin.label",
    descriptionKey: "widgets.promptPin.description",
    // The editor needs room for a title, textarea, agent row, and Done; the
    // ready card is a single title row. One frame size cannot serve both, and
    // a frame taller than the card leaves dead drag surface with the resize
    // handle floating below it — so each mode gets its own size profile.
    defaultSize: { width: 280, height: 170 },
    sizeBounds: {
      minWidth: 220,
      maxWidth: 420,
      minHeight: 140,
      maxHeight: 400,
    },
    resolveProfile: (instance) =>
      promptPinMode(instance.state) === "ready"
        ? {
            // Height is pinned rather than a range. The ready card is one row
            // of fixed-size content, so this is the only height that gives it
            // the same 16px padding the chat pin uses. A range would also let
            // a height persisted before this profile existed clamp to
            // something taller than the row and read as dead padding —
            // pinning it makes those instances self-heal on the next render.
            defaultSize: { width: 280, height: PROMPT_PIN_READY_HEIGHT },
            sizeBounds: {
              minWidth: 200,
              maxWidth: 420,
              minHeight: PROMPT_PIN_READY_HEIGHT,
              maxHeight: PROMPT_PIN_READY_HEIGHT,
            },
          }
        : {
            defaultSize: { width: 280, height: 170 },
            sizeBounds: {
              minWidth: 220,
              maxWidth: 420,
              minHeight: 140,
              maxHeight: 400,
            },
          },
    preservePositionOnProfileChange: true,
    Component: PromptPinWidget,
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
