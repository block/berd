import { describe, expect, it } from "vitest";
import type { LayoutItem } from "@/features/layout/api/layout";
import type { WidgetInstance } from "../widgets/types";
import {
  HOME_LAYOUT_REPLACE_KINDS,
  createDefaultClockLayoutItem,
  createDefaultClockWidget,
  homeWidgetsToLayoutItems,
  layoutItemsToHomeWidgets,
} from "./homeLayoutMapper";

function layoutItem(overrides: Partial<LayoutItem>): LayoutItem {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    kind: "session",
    targetId: "session-1",
    centerX: 120,
    centerY: 72,
    width: 240,
    height: 96,
    zIndex: 3,
    titleOverride: null,
    ...overrides,
  };
}

describe("homeLayoutMapper", () => {
  it("maps layout kinds to home widget types including projects and skills", () => {
    const widgets = layoutItemsToHomeWidgets([
      layoutItem({ kind: "clock", targetId: "widget:clock-1" }),
      layoutItem({ kind: "persona", targetId: "agent-1" }),
      layoutItem({ kind: "session", targetId: "session-1" }),
      layoutItem({ kind: "project", targetId: "project-1" }),
      layoutItem({ kind: "automation", targetId: "automation-1" }),
      layoutItem({ kind: "skill", targetId: "skill-1" }),
    ]);

    expect(widgets.map((widget) => widget.type)).toEqual([
      "clock",
      "agentPin",
      "chatPin",
      "projectArtifactPin",
      "automationOutputPin",
      "skillPin",
    ]);
    expect(HOME_LAYOUT_REPLACE_KINDS).toEqual([
      "clock",
      "persona",
      "session",
      "project",
      "automation",
      "skill",
    ]);
  });

  it("converts layout center coordinates to widget top-left coordinates", () => {
    const [widget] = layoutItemsToHomeWidgets([
      layoutItem({
        kind: "clock",
        centerX: 300,
        centerY: 360,
        zIndex: 7,
      }),
    ]);

    expect(widget).toMatchObject({
      id: "00000000-0000-0000-0000-000000000001",
      type: "clock",
      x: 180,
      y: 240,
      z: 7,
    });
  });

  it("converts widget top-left coordinates to layout center coordinates and catalog size", () => {
    const [item] = homeWidgetsToLayoutItems([
      {
        id: "00000000-0000-0000-0000-000000000001",
        type: "chatPin",
        x: 24,
        y: 48,
        z: 5,
        state: { sessionId: "session-1" },
      },
    ]);

    expect(item).toMatchObject({
      kind: "session",
      targetId: "session-1",
      centerX: 118,
      centerY: 88,
      width: 188,
      height: 80,
      zIndex: 5,
    });
  });

  it("populates entity state only for non-synthetic targets", () => {
    const widgets = layoutItemsToHomeWidgets([
      layoutItem({ kind: "persona", targetId: "agent-1" }),
      layoutItem({ kind: "session", targetId: "widget:session-pin" }),
      layoutItem({ kind: "project", targetId: "project-1" }),
      layoutItem({ kind: "automation", targetId: "automation-1" }),
    ]);

    expect(widgets[0].state).toEqual({ agentId: "agent-1" });
    expect(widgets[1].state).toBeUndefined();
    expect(widgets[2].state).toEqual({ projectId: "project-1" });
    expect(widgets[3].state).toEqual({ automationId: "automation-1" });
  });

  it("uses synthetic targets for clocks and widgets without entity state", () => {
    const widgets: WidgetInstance[] = [
      {
        id: "00000000-0000-0000-0000-000000000001",
        type: "clock",
        x: 0,
        y: 0,
        z: 1,
      },
      {
        id: "00000000-0000-0000-0000-000000000002",
        type: "agentPin",
        x: 0,
        y: 0,
        z: 2,
      },
    ];

    expect(
      homeWidgetsToLayoutItems(widgets).map((item) => item.targetId),
    ).toEqual([
      "widget:00000000-0000-0000-0000-000000000001",
      "widget:00000000-0000-0000-0000-000000000002",
    ]);
  });

  it("round-trips project artifact pins through project layout items", () => {
    const [item] = homeWidgetsToLayoutItems([
      {
        id: "00000000-0000-0000-0000-000000000003",
        type: "projectArtifactPin",
        x: 20,
        y: 30,
        z: 4,
        state: { projectId: "project-1" },
      },
    ]);

    expect(item).toMatchObject({
      kind: "project",
      targetId: "project-1",
      centerX: 130,
      centerY: 140,
      width: 220,
      height: 220,
      zIndex: 4,
    });

    const [widget] = layoutItemsToHomeWidgets([item]);
    expect(widget).toMatchObject({
      type: "projectArtifactPin",
      state: { projectId: "project-1" },
      x: 20,
      y: 30,
      z: 4,
    });
  });

  it("creates a default clock widget and layout item with a uuid id", () => {
    const widget = createDefaultClockWidget();
    const item = createDefaultClockLayoutItem();

    expect(widget).toMatchObject({
      type: "clock",
      x: 768,
      y: 24,
      z: 1,
    });
    expect(widget.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(item).toMatchObject({
      kind: "clock",
      targetId: `widget:${item.id}`,
      centerX: 888,
      centerY: 144,
    });
  });
});
