import type React from "react";
import type { LayoutConstraints } from "@/features/layout/api/layout";
import type { SkillInfo } from "@/features/skills/api/skills";

export type WidgetCategory =
  | "clock"
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

export interface WidgetInstance {
  id: string;
  type: string;
  x: number;
  y: number;
  z: number;
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
  onSelectSession?: (sessionId: string) => void;
  onStartProjectChat?: (projectId: string) => void;
  onOpenAutomation?: (automationId: string) => void;
}

export interface WidgetCatalogEntry {
  id: string;
  category: WidgetCategory;
  labelKey: string;
  descriptionKey?: string;
  defaultSize: WidgetSize;
  /** Renderable component for this widget type. Entries without a Component
   *  are catalog stubs — they appear in data but are not rendered on the canvas
   *  until the component is supplied (Task C fills in the pin types). */
  Component?: React.ComponentType<WidgetRenderProps>;
}

export interface WidgetNavigationHandlers {
  onOpenProject?: (projectId: string) => void;
  onOpenSkill?: (skill: SkillInfo) => void;
  onOpenAgent?: (agentId: string) => void;
  onSelectSession?: (sessionId: string) => void;
  onStartProjectChat?: (projectId: string) => void;
  onOpenAutomation?: (automationId: string) => void;
}

export interface WidgetMutationHandlers {
  addWidget: (
    type: string,
    x: number,
    y: number,
    state?: Record<string, unknown>,
    bounds?: LayoutConstraints,
  ) => void;
  moveWidget: (
    id: string,
    x: number,
    y: number,
    bounds?: LayoutConstraints,
    options?: MoveWidgetOptions,
  ) => void;
  bumpZ: (id: string) => void;
  removeWidget: (id: string) => void;
  updateWidgetState: (id: string, state: Record<string, unknown>) => void;
}

export type AgentPinState = { agentId: string };
export type ChatPinState = { sessionId: string };
export type ProjectArtifactPinState = { projectId: string };
export type AutomationOutputPinState = { automationId: string };
export type SkillPinState = { skillId: string };
