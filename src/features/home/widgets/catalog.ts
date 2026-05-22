import { AgentPinWidget } from "./AgentPinWidget";
import { AutomationOutputWidget } from "./AutomationOutputWidget";
import { ChatPinWidget } from "./ChatPinWidget";
import { ClockWidget } from "./ClockWidget";
import { ProjectArtifactWidget } from "./ProjectArtifactWidget";
import { SkillPinWidget } from "./SkillPinWidget";
import type { WidgetCatalogEntry, WidgetCategory } from "./types";

export const HOME_WIDGET_CATALOG: WidgetCatalogEntry[] = [
  {
    id: "clock",
    category: "clock",
    labelKey: "widgets.clock.label",
    descriptionKey: "widgets.clock.description",
    defaultSize: { width: 240, height: 240 },
    Component: ClockWidget,
  },
  {
    id: "agentPin",
    category: "agent",
    labelKey: "widgets.agentPin.label",
    defaultSize: { width: 240, height: 240 },
    Component: AgentPinWidget,
  },
  {
    id: "chatPin",
    category: "chat",
    labelKey: "widgets.chatPin.label",
    defaultSize: { width: 188, height: 80 },
    Component: ChatPinWidget,
  },
  {
    id: "projectArtifactPin",
    category: "project",
    labelKey: "widgets.projectArtifactPin.label",
    descriptionKey: "widgets.projectArtifactPin.description",
    defaultSize: { width: 220, height: 220 },
    Component: ProjectArtifactWidget,
  },
  {
    id: "automationOutputPin",
    category: "automation",
    labelKey: "widgets.automationOutputPin.label",
    descriptionKey: "widgets.automationOutputPin.description",
    defaultSize: { width: 244, height: 213 },
    Component: AutomationOutputWidget,
  },
  {
    id: "skillPin",
    category: "skill",
    labelKey: "widgets.skillPin.label",
    defaultSize: { width: 240, height: 96 },
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
