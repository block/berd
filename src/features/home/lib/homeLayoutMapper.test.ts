import { describe, expect, it } from "vitest";
import type { LayoutItem } from "@/features/layout/api/layout";
import type { WidgetInstance } from "../widgets/types";
import {
  HOME_LAYOUT_REPLACE_KINDS,
  createDefaultClockLayoutItem,
  createDefaultClockWidget,
  createDefaultHomeLayoutItems,
  createDefaultHomeWidgets,
  createDefaultStickyNoteWidgets,
  homeWidgetsToLayoutItems,
  layoutItemsToHomeWidgets,
  missingDefaultStickyNoteWidgets,
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
      layoutItem({ kind: "stickyNote", targetId: "onboarding:build-agent" }),
      layoutItem({ kind: "persona", targetId: "agent-1" }),
      layoutItem({ kind: "session", targetId: "session-1" }),
      layoutItem({ kind: "project", targetId: "project-1" }),
      layoutItem({ kind: "automation", targetId: "automation-1" }),
      layoutItem({ kind: "skill", targetId: "skill-1" }),
    ]);

    expect(widgets.map((widget) => widget.type)).toEqual([
      "clock",
      "stickyNote",
      "agentPin",
      "chatPin",
      "projectArtifactPin",
      "automationOutputPin",
      "skillPin",
    ]);
    expect(HOME_LAYOUT_REPLACE_KINDS).toEqual([
      "clock",
      "stickyNote",
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
      layoutItem({ kind: "stickyNote", targetId: "onboarding:build-agent" }),
      layoutItem({ kind: "persona", targetId: "agent-1" }),
      layoutItem({ kind: "session", targetId: "widget:session-pin" }),
      layoutItem({ kind: "project", targetId: "project-1" }),
      layoutItem({ kind: "automation", targetId: "automation-1" }),
    ]);

    expect(widgets[0].state).toEqual({ noteId: "onboarding:build-agent" });
    expect(widgets[1].state).toEqual({ agentId: "agent-1" });
    expect(widgets[2].state).toBeUndefined();
    expect(widgets[3].state).toEqual({ projectId: "project-1" });
    expect(widgets[4].state).toEqual({ automationId: "automation-1" });
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
        type: "stickyNote",
        x: 0,
        y: 0,
        z: 2,
        state: { noteId: "onboarding:build-agent" },
      },
      {
        id: "00000000-0000-0000-0000-000000000003",
        type: "agentPin",
        x: 0,
        y: 0,
        z: 3,
      },
    ];

    expect(
      homeWidgetsToLayoutItems(widgets).map((item) => item.targetId),
    ).toEqual([
      "widget:00000000-0000-0000-0000-000000000001",
      "onboarding:build-agent",
      "widget:00000000-0000-0000-0000-000000000003",
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
      centerX: 120,
      centerY: 130,
      width: 200,
      height: 200,
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

  it("round-trips explicit widget width and height", () => {
    const [item] = homeWidgetsToLayoutItems([
      {
        id: "00000000-0000-0000-0000-000000000004",
        type: "automationOutputPin",
        x: 24,
        y: 48,
        z: 6,
        width: 420,
        height: 240,
        state: { automationId: "automation-1" },
      },
    ]);

    expect(item).toMatchObject({
      kind: "automation",
      width: 420,
      height: 240,
      centerX: 234,
      centerY: 168,
    });

    const [widget] = layoutItemsToHomeWidgets([item]);
    expect(widget).toMatchObject({
      type: "automationOutputPin",
      x: 24,
      y: 48,
      width: 420,
      height: 240,
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

  it("creates default home widgets with onboarding sticky notes and a clock", () => {
    const widgets = createDefaultHomeWidgets();
    const items = createDefaultHomeLayoutItems();

    expect(widgets.map((widget) => widget.type)).toEqual([
      "stickyNote",
      "stickyNote",
      "stickyNote",
      "stickyNote",
      "stickyNote",
      "stickyNote",
      "clock",
    ]);
    expect(widgets.map((widget) => widget.z)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(
      widgets.slice(0, 6).map((widget) => ({ x: widget.x, y: widget.y })),
    ).toEqual([
      { x: -360, y: -240 },
      { x: -96, y: -240 },
      { x: 168, y: -240 },
      { x: -360, y: 0 },
      { x: -96, y: 0 },
      { x: 168, y: 0 },
    ]);
    expect(items.map((item) => item.kind)).toEqual([
      "stickyNote",
      "stickyNote",
      "stickyNote",
      "stickyNote",
      "stickyNote",
      "stickyNote",
      "clock",
    ]);
    expect(items.map((item) => item.targetId)).toEqual([
      "onboarding:welcome",
      "onboarding:start-project",
      "onboarding:build-agent",
      "onboarding:reuse-workflows",
      "onboarding:manage-automations",
      "onboarding:shape-home",
      `widget:${items[6].id}`,
    ]);
  });

  it("returns only missing default sticky notes", () => {
    const defaultStickies = createDefaultStickyNoteWidgets();
    const missingStickies = missingDefaultStickyNoteWidgets([
      defaultStickies[0],
      defaultStickies[1],
      defaultStickies[4],
      defaultStickies[5],
      defaultStickies[2],
    ]);

    expect(missingStickies).toHaveLength(1);
    expect(missingStickies[0].state).toEqual({
      noteId: "onboarding:reuse-workflows",
    });
  });
});
