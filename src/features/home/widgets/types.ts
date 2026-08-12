import type React from "react";
import type { LayoutConstraints } from "@/features/layout/api/layout";
import type { SkillInfo } from "@/features/skills/api/skills";

export type WidgetCategory =
  | "clock"
  | "note"
  | "checklist"
  | "photo"
  | "agent"
  | "chat"
  | "project"
  | "automation"
  | "skill";

export interface CanvasBounds {
  width: number;
  height: number;
}

export interface MoveWidgetOptions {
  bringToFront?: boolean;
}

export interface WidgetSize {
  width: number;
  height: number;
}

export interface WidgetSizeBounds {
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
  lockAspectRatio?: boolean;
}

export interface WidgetSizeProfile {
  defaultSize: WidgetSize;
  sizeBounds: WidgetSizeBounds;
}

export interface WidgetInstance {
  id: string;
  type: string;
  x: number;
  y: number;
  z: number;
  width?: number;
  height?: number;
  state?: Record<string, unknown>;
}

/** Props passed by WidgetFrame into every rendered widget component. */
export interface WidgetRenderProps {
  instance: WidgetInstance;
  onUpdateState: (next: Record<string, unknown>) => void;
  shouldIgnoreActivation?: () => boolean;
  onOpenProject?: (projectId: string) => void;
  onOpenSkill?: (skill: SkillInfo) => void;
  onOpenAgent?: (agentId: string) => void;
  onTagAgentInComposer?: (agentId: string) => void;
  onTagProjectInComposer?: (projectId: string) => void;
  onTagSkillInComposer?: (skill: SkillInfo) => void;
  onSelectSession?: (sessionId: string) => void;
  onStartProjectChat?: (projectId: string) => void;
  onOpenAutomation?: (automationId: string) => void;
  onCreatePersona?: () => void;
  onCreateProject?: () => void;
  onOpenSkills?: () => void;
  onOpenAutomations?: () => void;
  onStartOnboardingTour?: () => void;
  onResolveBerdyAgent?: () => Promise<string | null>;
  onRemoveWidget?: () => void;
  /** True while this widget is being dragged or resized on the home canvas. */
  canvasGestureActive?: boolean;
  /** Live world position while this widget is being dragged. */
  canvasDragPosition?: { x: number; y: number };
  /** True while live resize is previewing new bounds (content is CSS-scaled). */
  widgetResizePreviewActive?: boolean;
  /** True when the widget is mounted outside the visible home canvas viewport. */
  renderPaused?: boolean;
}

export interface WidgetCatalogEntry {
  id: string;
  category: WidgetCategory;
  labelKey: string;
  descriptionKey?: string;
  defaultSize: WidgetSize;
  sizeBounds: WidgetSizeBounds;
  /** Optional Tailwind classes for the canvas resize handle (defaults to corner). */
  resizeHandleClassName?: string;
  /** Hide the resize handle for fixed-size widgets. */
  hideResizeHandle?: boolean;
  /** Optional per-instance size profile. When present, sizing/resize use the
   *  returned profile instead of the entry's static defaultSize/sizeBounds. */
  resolveProfile?: (instance: WidgetInstance) => WidgetSizeProfile;
  /** Keep the current rendered width when state switches size profiles. */
  preserveWidthOnProfileChange?: boolean;
  /** Keep each instance's resolved size when organizing the canvas. */
  preserveSizeOnCleanUp?: boolean;
  /** Renderable component for this widget type. Entries without a Component
   *  are catalog stubs — they appear in data but are not rendered on the canvas
   *  until the component is supplied (Task C fills in the pin types). */
  Component?: React.ComponentType<WidgetRenderProps>;
}

export interface WidgetNavigationHandlers {
  onStartOnboardingTour?: () => void;
  onResolveBerdyAgent?: () => Promise<string | null>;
  onOpenProject?: (projectId: string) => void;
  onOpenSkill?: (skill: SkillInfo) => void;
  onOpenAgent?: (agentId: string) => void;
  onTagAgentInComposer?: (agentId: string) => void;
  onTagProjectInComposer?: (projectId: string) => void;
  onTagSkillInComposer?: (skill: SkillInfo) => void;
  onSelectSession?: (sessionId: string) => void;
  onStartProjectChat?: (projectId: string) => void;
  onOpenAutomation?: (automationId: string) => void;
  onCreatePersona?: () => void;
  onCreateProject?: () => void;
  onOpenSkills?: () => void;
  onOpenAutomations?: () => void;
}

export interface WidgetMutationHandlers {
  addWidget: (
    type: string,
    x: number,
    y: number,
    state?: Record<string, unknown>,
    bounds?: LayoutConstraints,
    options?: { notifyStarterTask?: boolean },
  ) => boolean;
  moveWidget: (
    id: string,
    x: number,
    y: number,
    bounds?: LayoutConstraints,
    options?: MoveWidgetOptions,
  ) => void;
  resizeWidget: (
    id: string,
    width: number,
    height: number,
    bounds?: LayoutConstraints,
    options?: MoveWidgetOptions,
  ) => void;
  bumpZ: (id: string) => void;
  removeWidget: (id: string) => void;
  updateWidgetState: (
    id: string,
    state: Record<string, unknown>,
    bounds?: LayoutConstraints,
  ) => void;
}

export type AgentPinState = { agentId: string };
export type ChatPinState = { sessionId: string };
export type ProjectArtifactPinState = { projectId: string };
export type AutomationOutputPinState = { automationId: string };
export type SkillPinState = { skillId: string };
export type StickyNoteState = { noteId: string };
export type PhotoShape = "original" | "square" | "circle";
export type PhotoState = {
  path?: string;
  shape?: PhotoShape;
  aspectRatio?: number;
};

export interface ChecklistItemState {
  id: string;
  text: string;
  done: boolean;
}
export type ChecklistState = {
  title?: string;
  tone?: string;
  fontSize?: string;
  items?: ChecklistItemState[];
};
