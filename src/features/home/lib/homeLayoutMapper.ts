import type { LayoutItem, LayoutItemKind } from "@/features/layout/api/layout";
import { STARTER_PROJECT_ID } from "@/features/home/onboarding/starterTasks";
import {
  clampWidgetSize,
  clampWidgetSizeForInstance,
  HOME_WIDGET_CATALOG_BY_ID,
  widgetSizeForInstance,
} from "../widgets/catalog";
import { clockModeOf } from "../widgets/clockWidgetMode";
import {
  LABEL_FONT_FAMILIES,
  type LabelFontFamily,
} from "../widgets/labelWidgetModel";
import type { CanvasBounds, WidgetInstance } from "../widgets/types";
import { clampToBounds, snapPoint } from "./snapToGrid";

export const HOME_LAYOUT_REPLACE_KINDS = [
  "clock",
  "stickyNote",
  "checklist",
  "photo",
  "persona",
  "session",
  "project",
  "automation",
  "skill",
  "prompt",
] as const satisfies LayoutItemKind[];

type HomeLayoutKind = (typeof HOME_LAYOUT_REPLACE_KINDS)[number];

const DEFAULT_CANVAS: CanvasBounds = { width: 1080, height: 760 };
const DEFAULT_CLOCK_ANCHOR = { x: 0.83, y: 0.18 };
// The rendered Berdy artwork has transparent space to its right, so its visual
// center sits left of the 160px media box's geometric center.
const ONBOARDING_AVATAR_CENTER_IN_WIDGET = { x: 72, y: 90 };
const ONBOARDING_CLOCK_GAP = 32;

const KIND_TO_WIDGET_TYPE = {
  clock: "clock",
  stickyNote: "stickyNote",
  checklist: "checklist",
  photo: "photo",
  persona: "agentPin",
  session: "chatPin",
  project: "projectArtifactPin",
  automation: "automationOutputPin",
  skill: "skillPin",
  prompt: "promptPin",
} as const satisfies Record<HomeLayoutKind, string>;

const WIDGET_TYPE_TO_KIND: Partial<Record<string, HomeLayoutKind>> = {
  onboardingTour: "stickyNote",
  onboardingProjectArtifact: "stickyNote",
  clock: "clock",
  stickyNote: "stickyNote",
  label: "stickyNote",
  checklist: "checklist",
  photo: "photo",
  agentPin: "persona",
  chatPin: "session",
  projectArtifactPin: "project",
  automationOutputPin: "automation",
  skillPin: "skill",
  promptPin: "prompt",
};

function isHomeLayoutKind(kind: LayoutItemKind): kind is HomeLayoutKind {
  switch (kind) {
    case "clock":
    case "stickyNote":
    case "checklist":
    case "photo":
    case "persona":
    case "session":
    case "project":
    case "automation":
    case "skill":
    case "prompt":
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
const LABEL_WIDGET_VARIANT = "label";

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

function persistedChatStateFromItem(
  item: LayoutItem,
): Record<string, unknown> | undefined {
  if (typeof item.widgetState !== "object" || item.widgetState === null) {
    return undefined;
  }

  const state: Record<string, unknown> = {};
  if (
    item.widgetState.presentation === "expanded" ||
    item.widgetState.presentation === "collapsed"
  ) {
    state.presentation = item.widgetState.presentation;
  }
  const sizeByProfile = readSizeByProfile(item.widgetState);
  if (sizeByProfile) {
    state[SIZE_BY_PROFILE_STATE_KEY] = sizeByProfile;
  }
  return Object.keys(state).length > 0 ? state : undefined;
}

function persistedClockStateFromItem(
  item: LayoutItem,
): Record<string, unknown> | undefined {
  const sizeByProfile = readSizeByProfile(item.widgetState);
  return sizeByProfile
    ? { [SIZE_BY_PROFILE_STATE_KEY]: sizeByProfile }
    : undefined;
}

function persistedStickyNoteStateFromItem(
  item: LayoutItem,
): Record<string, unknown> | undefined {
  if (typeof item.widgetState !== "object" || item.widgetState === null) {
    return undefined;
  }

  const state: Record<string, unknown> = {};
  if (typeof item.widgetState.text === "string") {
    state.text = item.widgetState.text;
  }
  if (typeof item.widgetState.html === "string") {
    state.html = item.widgetState.html;
  }
  const isLabel =
    item.widgetState.variant === LABEL_WIDGET_VARIANT ||
    item.widgetState.tone === LABEL_WIDGET_VARIANT;
  if (typeof item.widgetState.tone === "string" && !isLabel) {
    state.tone = item.widgetState.tone;
  }
  if (typeof item.widgetState.fontSize === "string") {
    state.fontSize = item.widgetState.fontSize;
  }
  if (
    typeof item.widgetState.fontSizePx === "number" &&
    Number.isFinite(item.widgetState.fontSizePx)
  ) {
    state.fontSizePx = item.widgetState.fontSizePx;
  }
  if (
    LABEL_FONT_FAMILIES.includes(item.widgetState.fontFamily as LabelFontFamily)
  ) {
    state.fontFamily = item.widgetState.fontFamily;
  }
  if (isLabel) {
    state.variant = LABEL_WIDGET_VARIANT;
  }
  if (
    item.targetId === "onboarding:tour" &&
    item.widgetState.welcomeDismissed === true
  ) {
    state.welcomeDismissed = true;
  }

  return Object.keys(state).length > 0 ? state : undefined;
}

function sanitizeChecklistItems(
  value: unknown,
): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: Array<Record<string, unknown>> = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.id === "string" && typeof record.text === "string") {
      items.push({
        id: record.id,
        text: record.text,
        done: record.done === true,
      });
    }
  }
  return items;
}

function persistedChecklistStateFromItem(
  item: LayoutItem,
): Record<string, unknown> | undefined {
  if (typeof item.widgetState !== "object" || item.widgetState === null) {
    return undefined;
  }

  const state: Record<string, unknown> = {};
  if (typeof item.widgetState.title === "string") {
    state.title = item.widgetState.title;
  }
  if (typeof item.widgetState.tone === "string") {
    state.tone = item.widgetState.tone;
  }
  if (typeof item.widgetState.fontSize === "string") {
    state.fontSize = item.widgetState.fontSize;
  }
  const items = sanitizeChecklistItems(item.widgetState.items);
  if (items.length > 0) {
    state.items = items;
  }

  return Object.keys(state).length > 0 ? state : undefined;
}

function sanitizePhotoState(
  value: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

  const state: Record<string, unknown> = {};
  const sizeByProfile = readSizeByProfile(value);
  if (sizeByProfile) {
    state[SIZE_BY_PROFILE_STATE_KEY] = sizeByProfile;
  }
  if (typeof value.path === "string" && value.path.trim()) {
    state.path = value.path.trim();
  }
  if (
    typeof value.aspectRatio === "number" &&
    Number.isFinite(value.aspectRatio) &&
    value.aspectRatio > 0
  ) {
    state.aspectRatio = value.aspectRatio;
  }
  if (
    value.shape === "original" ||
    value.shape === "square" ||
    value.shape === "circle"
  ) {
    state.shape = value.shape;
  }
  return Object.keys(state).length > 0 ? state : undefined;
}

function persistedPhotoStateFromItem(
  item: LayoutItem,
): Record<string, unknown> | undefined {
  return typeof item.widgetState === "object" && item.widgetState !== null
    ? sanitizePhotoState(item.widgetState)
    : undefined;
}

// Matches the send pipeline's prompt bound (berdctl session create).
const PROMPT_PIN_TEXT_MAX_LENGTH = 50_000;
const PROMPT_PIN_TITLE_MAX_LENGTH = 200;

function sanitizePromptPinState(
  value: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

  const state: Record<string, unknown> = {};
  if (typeof value.title === "string" && value.title.trim()) {
    state.title = value.title.slice(0, PROMPT_PIN_TITLE_MAX_LENGTH);
  }
  if (typeof value.text === "string" && value.text.trim()) {
    state.text = value.text.slice(0, PROMPT_PIN_TEXT_MAX_LENGTH);
  }
  const agentId = nonEmptyStateString(value.agentId);
  if (agentId) {
    state.agentId = agentId;
  }
  if (value.mode === "edit" || value.mode === "ready") {
    state.mode = value.mode;
  }
  const sizeByProfile = readSizeByProfile(value);
  if (sizeByProfile) {
    state[SIZE_BY_PROFILE_STATE_KEY] = sizeByProfile;
  }
  return Object.keys(state).length > 0 ? state : undefined;
}

function persistedPromptPinStateFromItem(
  item: LayoutItem,
): Record<string, unknown> | undefined {
  return typeof item.widgetState === "object" && item.widgetState !== null
    ? sanitizePromptPinState(item.widgetState)
    : undefined;
}

function stateForItem(item: LayoutItem): Record<string, unknown> | undefined {
  if (item.kind !== "clock" && isSyntheticTarget(item.targetId)) {
    if (item.kind === "stickyNote") {
      return persistedStickyNoteStateFromItem(item);
    }
    if (item.kind === "checklist") {
      return persistedChecklistStateFromItem(item);
    }
    if (item.kind === "photo") {
      return persistedPhotoStateFromItem(item);
    }
    if (item.kind === "prompt") {
      return persistedPromptPinStateFromItem(item);
    }
    return undefined;
  }

  switch (item.kind) {
    case "persona":
      return { agentId: item.targetId };
    case "session":
      return mergeState(
        { sessionId: item.targetId },
        persistedChatStateFromItem(item),
      );
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
      if (item.targetId === "onboarding:starter-project") {
        const persistedState =
          typeof item.widgetState === "object" && item.widgetState !== null
            ? item.widgetState
            : {};
        return {
          projectId:
            nonEmptyStateString(persistedState.projectId) ?? STARTER_PROJECT_ID,
          onboardingStarterProject: true,
        };
      }
      return mergeState(
        { noteId: item.targetId },
        persistedStickyNoteStateFromItem(item),
      );
    case "checklist":
      return persistedChecklistStateFromItem(item);
    case "photo":
      return persistedPhotoStateFromItem(item);
    case "skill":
      return { skillId: item.targetId };
    case "prompt":
      return persistedPromptPinStateFromItem(item);
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
  switch (kind) {
    case "clock": {
      const sizeByProfile = readSizeByProfile(instance.state);
      return sizeByProfile
        ? { [SIZE_BY_PROFILE_STATE_KEY]: sizeByProfile }
        : undefined;
    }
    case "stickyNote": {
      if (instance.type === "onboardingProjectArtifact") {
        return {
          projectId:
            nonEmptyStateString(instance.state?.projectId) ??
            STARTER_PROJECT_ID,
          onboardingStarterProject: true,
        };
      }
      const state: Record<string, unknown> = {};
      if (instance.type === "label") {
        state.variant = LABEL_WIDGET_VARIANT;
      }
      if (typeof instance.state?.text === "string") {
        state.text = instance.state.text;
      }
      if (typeof instance.state?.html === "string") {
        state.html = instance.state.html;
      }
      if (typeof instance.state?.tone === "string") {
        state.tone = instance.state.tone;
      }
      if (typeof instance.state?.fontSize === "string") {
        state.fontSize = instance.state.fontSize;
      }
      if (
        typeof instance.state?.fontSizePx === "number" &&
        Number.isFinite(instance.state.fontSizePx)
      ) {
        state.fontSizePx = instance.state.fontSizePx;
      }
      if (
        LABEL_FONT_FAMILIES.includes(
          instance.state?.fontFamily as LabelFontFamily,
        )
      ) {
        state.fontFamily = instance.state?.fontFamily;
      }
      if (
        instance.type === "onboardingTour" &&
        instance.state?.welcomeDismissed === true
      ) {
        state.welcomeDismissed = true;
      }
      return Object.keys(state).length > 0 ? state : undefined;
    }
    case "checklist": {
      const state: Record<string, unknown> = {};
      if (typeof instance.state?.title === "string") {
        state.title = instance.state.title;
      }
      if (typeof instance.state?.tone === "string") {
        state.tone = instance.state.tone;
      }
      if (typeof instance.state?.fontSize === "string") {
        state.fontSize = instance.state.fontSize;
      }
      const items = sanitizeChecklistItems(instance.state?.items);
      if (items.length > 0) {
        state.items = items;
      }
      return Object.keys(state).length > 0 ? state : undefined;
    }
    case "photo":
      return sanitizePhotoState(instance.state);
    case "session": {
      const state: Record<string, unknown> = {};
      if (
        instance.state?.presentation === "expanded" ||
        instance.state?.presentation === "collapsed"
      ) {
        state.presentation = instance.state.presentation;
      }
      const sizeByProfile = readSizeByProfile(instance.state);
      if (sizeByProfile) {
        state[SIZE_BY_PROFILE_STATE_KEY] = sizeByProfile;
      }
      return Object.keys(state).length > 0 ? state : undefined;
    }
    case "prompt":
      return sanitizePromptPinState(instance.state);
    case "persona":
    case "project":
    case "automation":
    case "skill":
      return undefined;
    default: {
      const exhaustive: never = kind;
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
      return clockModeOf(instance) === "digital"
        ? `${syntheticTarget(instance.id)}${DIGITAL_CLOCK_TARGET_SUFFIX}`
        : syntheticTarget(instance.id);
    case "stickyNote":
      if (instance.type === "onboardingProjectArtifact") {
        return "onboarding:starter-project";
      }
      return nonEmptyStateString(state.noteId) ?? syntheticTarget(instance.id);
    case "checklist":
    case "photo":
    case "prompt":
      return syntheticTarget(instance.id);
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
    const type =
      item.kind === "stickyNote" && item.targetId === "onboarding:tour"
        ? "onboardingTour"
        : item.kind === "stickyNote" &&
            item.targetId === "onboarding:starter-project"
          ? "onboardingProjectArtifact"
          : item.kind === "stickyNote" &&
              (item.widgetState?.variant === LABEL_WIDGET_VARIANT ||
                item.widgetState?.tone === LABEL_WIDGET_VARIANT)
            ? "label"
            : KIND_TO_WIDGET_TYPE[item.kind];
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

export function createDefaultOnboardingTourWidget(
  clock = createDefaultClockWidget(),
): WidgetInstance {
  const width = 448;
  const height = 180;
  const clockSize = widgetSizeForInstance(clock);

  return {
    id: crypto.randomUUID(),
    type: "onboardingTour",
    x: clock.x + clockSize.width / 2 - width / 2,
    y: clock.y + clockSize.height + ONBOARDING_CLOCK_GAP,
    z: 1,
    width,
    height,
    state: { noteId: "onboarding:tour" },
  };
}

export function onboardingTourAvatarCenter(instance: WidgetInstance): {
  x: number;
  y: number;
} {
  return {
    x: instance.x + ONBOARDING_AVATAR_CENTER_IN_WIDGET.x,
    y: instance.y + ONBOARDING_AVATAR_CENTER_IN_WIDGET.y,
  };
}

export function createDefaultStickyNoteWidgets(): WidgetInstance[] {
  return createDefaultOnboardingWidgets(false);
}

export function createDefaultOnboardingWidgets(
  berdyOnboardingEnabled: boolean,
): WidgetInstance[] {
  return [
    berdyOnboardingEnabled
      ? createDefaultOnboardingTourWidget()
      : {
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
  if (instance.type !== "stickyNote" && instance.type !== "onboardingTour") {
    return null;
  }

  const noteId = instance.state?.noteId;
  return typeof noteId === "string" && noteId.trim() ? noteId.trim() : null;
}

export function isUntouchedLegacyWelcomeStickyNote(
  instance: WidgetInstance,
): boolean {
  if (defaultStickyNoteId(instance) !== "onboarding:welcome") {
    return false;
  }

  const hasCustomizedState = ["text", "html", "tone", "fontSize"].some(
    (key) => instance.state?.[key] !== undefined,
  );

  return (
    !hasCustomizedState &&
    instance.x === -360 &&
    (instance.y === -250 || instance.y === -240) &&
    instance.width === 224 &&
    instance.height === 196
  );
}

/**
 * Reconcile the experiment-owned onboarding widget without overriding a
 * user's canvas choice. An untouched legacy welcome note is the migration
 * marker for opting in; no marker and no tour means the user removed Berdy.
 */
export function reconcileOnboardingExperimentWidgets(
  instances: WidgetInstance[],
  enabled: boolean,
): WidgetInstance[] {
  const hasOnboardingTour = instances.some(
    (instance) => defaultStickyNoteId(instance) === "onboarding:tour",
  );

  if (!enabled) {
    if (!hasOnboardingTour) {
      return instances;
    }

    const withoutOnboardingTour = instances.filter(
      (instance) => defaultStickyNoteId(instance) !== "onboarding:tour",
    );
    const hasLegacyWelcome = withoutOnboardingTour.some(
      (instance) => defaultStickyNoteId(instance) === "onboarding:welcome",
    );
    if (hasLegacyWelcome) {
      return withoutOnboardingTour;
    }

    const legacyWelcome = createDefaultOnboardingWidgets(false)[0];
    const maxZ = withoutOnboardingTour.reduce(
      (currentMax, instance) => Math.max(currentMax, instance.z),
      0,
    );
    return [...withoutOnboardingTour, { ...legacyWelcome, z: maxZ + 1 }];
  }

  const withoutUntouchedLegacyWelcome = instances.filter(
    (instance) => !isUntouchedLegacyWelcomeStickyNote(instance),
  );
  if (hasOnboardingTour) {
    return withoutUntouchedLegacyWelcome.length === instances.length
      ? instances
      : withoutUntouchedLegacyWelcome;
  }

  const hasUntouchedLegacyWelcome =
    withoutUntouchedLegacyWelcome.length !== instances.length;
  if (!hasUntouchedLegacyWelcome) {
    return instances;
  }

  const clock = instances.find((instance) => instance.type === "clock");
  const onboardingTour = createDefaultOnboardingTourWidget(clock);
  const maxZ = withoutUntouchedLegacyWelcome.reduce(
    (currentMax, instance) => Math.max(currentMax, instance.z),
    0,
  );
  return [...withoutUntouchedLegacyWelcome, { ...onboardingTour, z: maxZ + 1 }];
}

export function missingDefaultStickyNoteWidgets(
  instances: WidgetInstance[],
  berdyOnboardingEnabled = false,
): WidgetInstance[] {
  const existingNoteIds = new Set(
    instances.flatMap((instance) => {
      const noteId = defaultStickyNoteId(instance);
      return noteId ? [noteId] : [];
    }),
  );

  return createDefaultOnboardingWidgets(berdyOnboardingEnabled).filter(
    (instance) => {
      const noteId = defaultStickyNoteId(instance);
      return noteId !== null && !existingNoteIds.has(noteId);
    },
  );
}

export function createDefaultHomeWidgets(
  bounds: CanvasBounds = DEFAULT_CANVAS,
  berdyOnboardingEnabled = false,
): WidgetInstance[] {
  return [
    ...createDefaultOnboardingWidgets(berdyOnboardingEnabled),
    {
      ...createDefaultClockWidget(bounds),
      z: 7,
    },
  ];
}

export function createDefaultHomeLayoutItems(
  bounds?: CanvasBounds,
  berdyOnboardingEnabled = false,
): LayoutItem[] {
  return homeWidgetsToLayoutItems(
    createDefaultHomeWidgets(bounds, berdyOnboardingEnabled),
  );
}
