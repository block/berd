import { describe, expect, it } from "vitest";
import type { LayoutItem } from "@/features/layout/api/layout";
import type { WidgetInstance } from "../widgets/types";
import {
  HOME_LAYOUT_REPLACE_KINDS,
  createDefaultClockLayoutItem,
  createDefaultClockWidget,
  createDefaultHomeLayoutItems,
  createDefaultHomeWidgets,
  createDefaultOnboardingTourWidget,
  createDefaultStickyNoteWidgets,
  homeWidgetsToLayoutItems,
  layoutItemsToHomeWidgets,
  missingDefaultStickyNoteWidgets,
  onboardingTourAvatarCenter,
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
  it("round-trips the onboarding starter project as a sticky-note-backed cube", () => {
    const widget: WidgetInstance = {
      id: "00000000-0000-0000-0000-000000000099",
      type: "onboardingProjectArtifact",
      x: 300,
      y: -260,
      z: 5,
      width: 400,
      height: 400,
      state: {
        projectId: "onboarding-starter-project",
        onboardingStarterProject: true,
      },
    };

    const [item] = homeWidgetsToLayoutItems([widget]);
    expect(item).toMatchObject({
      kind: "stickyNote",
      targetId: "onboarding:starter-project",
      width: 400,
      height: 400,
    });
    expect(layoutItemsToHomeWidgets([item])).toMatchObject([
      {
        type: "onboardingProjectArtifact",
        width: 400,
        height: 400,
        state: {
          projectId: "onboarding-starter-project",
          onboardingStarterProject: true,
        },
      },
    ]);
  });
  it("maps layout kinds to home widget types including projects and skills", () => {
    const widgets = layoutItemsToHomeWidgets([
      layoutItem({ kind: "clock", targetId: "widget:clock-1" }),
      layoutItem({ kind: "stickyNote", targetId: "onboarding:build-agent" }),
      layoutItem({ kind: "photo", targetId: "widget:photo-1" }),
      layoutItem({ kind: "persona", targetId: "agent-1" }),
      layoutItem({ kind: "session", targetId: "session-1" }),
      layoutItem({ kind: "project", targetId: "project-1" }),
      layoutItem({ kind: "automation", targetId: "automation-1" }),
      layoutItem({ kind: "skill", targetId: "skill-1" }),
      layoutItem({ kind: "prompt", targetId: "widget:prompt-1" }),
    ]);

    expect(widgets.map((widget) => widget.type)).toEqual([
      "clock",
      "stickyNote",
      "photo",
      "agentPin",
      "chatPin",
      "projectArtifactPin",
      "automationOutputPin",
      "skillPin",
      "promptPin",
    ]);
    expect(HOME_LAYOUT_REPLACE_KINDS).toEqual([
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

  it("round-trips an expanded chat presentation and its size memory", () => {
    const widget: WidgetInstance = {
      id: "00000000-0000-0000-0000-000000000001",
      type: "chatPin",
      x: 24,
      y: 48,
      z: 5,
      width: 480,
      height: 560,
      state: {
        sessionId: "session-1",
        presentation: "expanded",
        __sizeByProfile: {
          "188x80": { width: 188, height: 80 },
        },
      },
    };

    const [item] = homeWidgetsToLayoutItems([widget]);

    expect(item.widgetState).toEqual({
      presentation: "expanded",
      __sizeByProfile: {
        "188x80": { width: 188, height: 80 },
      },
    });
    expect(layoutItemsToHomeWidgets([item])[0]).toMatchObject({
      type: "chatPin",
      width: 480,
      height: 560,
      state: {
        sessionId: "session-1",
        presentation: "expanded",
        __sizeByProfile: {
          "188x80": { width: 188, height: 80 },
        },
      },
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

  it("round-trips editable sticky note content through widget state", () => {
    const [item] = homeWidgetsToLayoutItems([
      {
        id: "note-1",
        type: "stickyNote",
        x: 32,
        y: 64,
        z: 2,
        width: 280,
        height: 220,
        state: {
          text: "Follow up on release notes",
          html: "Follow up on <strong>release</strong> notes",
          tone: "cool",
        },
      },
    ]);

    expect(item).toMatchObject({
      kind: "stickyNote",
      targetId: "widget:note-1",
      widgetState: {
        text: "Follow up on release notes",
        html: "Follow up on <strong>release</strong> notes",
        tone: "cool",
      },
    });

    const [restored] = layoutItemsToHomeWidgets([item]);
    expect(restored).toMatchObject({
      id: "note-1",
      type: "stickyNote",
      x: 32,
      y: 64,
      z: 2,
      width: 280,
      height: 220,
      state: {
        text: "Follow up on release notes",
        html: "Follow up on <strong>release</strong> notes",
        tone: "cool",
      },
    });
  });

  it("round-trips labels as their own frontend type through sticky-note persistence", () => {
    const [item] = homeWidgetsToLayoutItems([
      {
        id: "label-1",
        type: "label",
        x: 24,
        y: 40,
        z: 3,
        width: 280,
        height: 56,
        state: {
          text: "Weekly automations",
          fontSizePx: 24,
          fontFamily: "serif",
        },
      },
    ]);

    expect(item).toMatchObject({
      kind: "stickyNote",
      targetId: "widget:label-1",
      widgetState: {
        variant: "label",
        text: "Weekly automations",
        fontSizePx: 24,
        fontFamily: "serif",
      },
    });

    const [restored] = layoutItemsToHomeWidgets([item]);
    expect(restored).toMatchObject({
      id: "label-1",
      type: "label",
      x: 24,
      y: 40,
      width: 280,
      height: 56,
      state: {
        variant: "label",
        text: "Weekly automations",
        fontSizePx: 24,
        fontFamily: "serif",
      },
    });
  });

  it("upgrades legacy label tones into standalone labels", () => {
    const [restored] = layoutItemsToHomeWidgets([
      layoutItem({
        id: "legacy-label",
        kind: "stickyNote",
        targetId: "widget:legacy-label",
        width: 280,
        height: 56,
        widgetState: { tone: "label", text: "ANZ" },
      }),
    ]);

    expect(restored).toMatchObject({
      type: "label",
      state: { variant: "label", text: "ANZ" },
    });
    expect(restored.state).not.toHaveProperty("tone");
  });

  it("round-trips photo path and shape through widget state", () => {
    const [item] = homeWidgetsToLayoutItems([
      {
        id: "photo-1",
        type: "photo",
        x: 20,
        y: 30,
        z: 4,
        width: 240,
        height: 240,
        state: {
          path: "/app/home-widget-media/photo.jpg",
          shape: "circle",
          aspectRatio: 4 / 3,
        },
      },
    ]);

    expect(item).toMatchObject({
      kind: "photo",
      targetId: "widget:photo-1",
      widgetState: {
        path: "/app/home-widget-media/photo.jpg",
        shape: "circle",
        aspectRatio: 4 / 3,
      },
    });

    const [restored] = layoutItemsToHomeWidgets([item]);
    expect(restored).toMatchObject({
      type: "photo",
      x: 20,
      y: 30,
      width: 240,
      height: 240,
      state: {
        path: "/app/home-widget-media/photo.jpg",
        shape: "circle",
        aspectRatio: 4 / 3,
      },
    });
  });

  it("drops invalid photo aspect ratios in both mapper directions", () => {
    const [item] = homeWidgetsToLayoutItems([
      {
        id: "photo-invalid-ratio",
        type: "photo",
        x: 20,
        y: 30,
        z: 4,
        state: {
          path: "/app/home-widget-media/photo.jpg",
          shape: "original",
          aspectRatio: -2,
        },
      },
    ]);
    expect(item.widgetState).toEqual({
      path: "/app/home-widget-media/photo.jpg",
      shape: "original",
    });

    const [restored] = layoutItemsToHomeWidgets([
      {
        ...item,
        widgetState: { ...item.widgetState, aspectRatio: 0 },
      },
    ]);
    expect(restored.state).toEqual({
      path: "/app/home-widget-media/photo.jpg",
      shape: "original",
    });
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

  it("round-trips prompt pin content through widget state", () => {
    const [item] = homeWidgetsToLayoutItems([
      {
        id: "prompt-1",
        type: "promptPin",
        x: 40,
        y: 60,
        z: 3,
        width: 240,
        height: 200,
        state: {
          title: "Daily standup",
          text: "Summarize yesterday's commits and draft a standup update.",
          agentId: "agent-1",
        },
      },
    ]);

    expect(item).toMatchObject({
      kind: "prompt",
      targetId: "widget:prompt-1",
      widgetState: {
        title: "Daily standup",
        text: "Summarize yesterday's commits and draft a standup update.",
        agentId: "agent-1",
      },
    });

    const [restored] = layoutItemsToHomeWidgets([item]);
    expect(restored).toMatchObject({
      id: "prompt-1",
      type: "promptPin",
      x: 40,
      y: 60,
      z: 3,
      state: {
        title: "Daily standup",
        text: "Summarize yesterday's commits and draft a standup update.",
        agentId: "agent-1",
      },
    });
  });

  it("sanitizes prompt pin state in both mapper directions", () => {
    const [item] = homeWidgetsToLayoutItems([
      {
        id: "prompt-2",
        type: "promptPin",
        x: 0,
        y: 0,
        z: 1,
        state: {
          title: "   ",
          text: `${"x".repeat(50_001)}`,
          agentId: "  agent-2  ",
          unknownField: "dropped",
        },
      },
    ]);

    expect(item.widgetState).toEqual({
      text: "x".repeat(50_000),
      agentId: "agent-2",
    });

    const [restored] = layoutItemsToHomeWidgets([
      {
        ...item,
        widgetState: { ...item.widgetState, extra: 1, agentId: "" },
      },
    ]);
    expect(restored.state).toEqual({ text: "x".repeat(50_000) });
  });

  // The mode drives the size profile, and the per-profile size memory rides
  // along with it, so both have to survive the round trip.
  it("round-trips prompt pin mode and per-profile size memory", () => {
    const [item] = homeWidgetsToLayoutItems([
      {
        id: "prompt-3",
        type: "promptPin",
        x: 0,
        y: 0,
        z: 1,
        state: {
          text: "Summarize my inbox",
          mode: "ready",
          __sizeByProfile: {
            "280x170": { width: 300, height: 200 },
          },
        },
      },
    ]);

    expect(item.widgetState).toEqual({
      text: "Summarize my inbox",
      mode: "ready",
      __sizeByProfile: { "280x170": { width: 300, height: 200 } },
    });

    const [restored] = layoutItemsToHomeWidgets([item]);
    expect(restored.state).toMatchObject({
      mode: "ready",
      __sizeByProfile: { "280x170": { width: 300, height: 200 } },
    });
  });

  it("drops an unrecognized prompt pin mode", () => {
    const [item] = homeWidgetsToLayoutItems([
      {
        id: "prompt-4",
        type: "promptPin",
        x: 0,
        y: 0,
        z: 1,
        state: { text: "Summarize my inbox", mode: "bogus" },
      },
    ]);

    expect(item.widgetState).toEqual({ text: "Summarize my inbox" });
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
      x: 816,
      y: 48,
      z: 1,
    });
    expect(widget.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(item).toMatchObject({
      kind: "clock",
      targetId: `widget:${item.id}`,
      centerX: 894,
      centerY: 126,
    });
  });

  it("creates default home widgets with onboarding sticky notes and a clock", () => {
    const widgets = createDefaultHomeWidgets(undefined, true);
    const items = createDefaultHomeLayoutItems(undefined, true);

    expect(widgets.map((widget) => widget.type)).toEqual([
      "onboardingTour",
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
      { x: 670, y: 236 },
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
      "onboarding:tour",
      "onboarding:start-project",
      "onboarding:build-agent",
      "onboarding:reuse-workflows",
      "onboarding:manage-automations",
      "onboarding:shape-home",
      `widget:${items[6].id}`,
    ]);
  });

  it("locates Berdy's avatar for initial camera centering", () => {
    const widget = createDefaultOnboardingTourWidget();

    expect(onboardingTourAvatarCenter(widget)).toEqual({ x: 742, y: 326 });
  });

  it("persists the completed welcome callout for Berdy", () => {
    const onboardingTour = {
      ...createDefaultOnboardingTourWidget(),
      state: {
        noteId: "onboarding:tour",
        welcomeDismissed: true,
      },
    };

    const [item] = homeWidgetsToLayoutItems([onboardingTour]);
    const [restored] = layoutItemsToHomeWidgets([item]);

    expect(item.widgetState).toEqual({ welcomeDismissed: true });
    expect(restored).toMatchObject({
      type: "onboardingTour",
      state: {
        noteId: "onboarding:tour",
        welcomeDismissed: true,
      },
    });
  });

  it("centers the Berdy and bubble lockup beneath the default clock", () => {
    const onboardingTour = createDefaultOnboardingTourWidget();
    const clock = createDefaultClockWidget();

    expect(onboardingTour.x + (onboardingTour.width ?? 0) / 2).toBeCloseTo(
      clock.x + (clock.width ?? 0) / 2,
    );
    expect(onboardingTour.y - (clock.y + (clock.height ?? 0))).toBe(32);
  });

  describe("clock mode persistence round-trip", () => {
    it("encodes digital mode into the clock targetId and round-trips it", () => {
      const digitalClock = {
        id: "clk-1",
        type: "clock",
        x: 100,
        y: 50,
        z: 3,
        width: 264,
        height: 104,
        state: { mode: "digital" },
      } as const;

      const [item] = homeWidgetsToLayoutItems([{ ...digitalClock }]);
      expect(item.kind).toBe("clock");
      expect(item.targetId.endsWith(":digital")).toBe(true);
      expect(item.width).toBe(264);
      expect(item.height).toBeCloseTo(264 * (88 / 224));

      const [restored] = layoutItemsToHomeWidgets([item]);
      expect(restored.state).toEqual({ mode: "digital" });
      expect(restored.width).toBe(264);
      expect(restored.height).toBeCloseTo(264 * (88 / 224));
    });

    it("leaves an analog clock with a plain synthetic target and no state", () => {
      const analogClock = {
        id: "clk-2",
        type: "clock",
        x: 0,
        y: 0,
        z: 1,
        width: 240,
        height: 240,
      } as const;

      const [item] = homeWidgetsToLayoutItems([{ ...analogClock }]);
      expect(item.targetId).toBe("widget:clk-2");
      expect(item.targetId.includes(":digital")).toBe(false);

      const [restored] = layoutItemsToHomeWidgets([item]);
      expect(restored.state).toBeUndefined();
      expect(restored.width).toBe(240);
      expect(restored.height).toBe(240);
    });

    it("reshapes a persisted digital clock to the digital profile on load", () => {
      // Simulate a stored digital clock item directly.
      const storedDigital = {
        id: "clk-3",
        kind: "clock" as const,
        targetId: "widget:clk-3:digital",
        centerX: 200,
        centerY: 200,
        width: 264,
        height: 104,
        zIndex: 2,
        titleOverride: null,
      };
      const [restored] = layoutItemsToHomeWidgets([storedDigital]);
      expect(restored.state).toEqual({ mode: "digital" });
      expect(restored.width).toBe(264);
      expect(restored.height).toBeCloseTo(264 * (88 / 224));
    });

    it("round-trips clock per-mode sizes through persisted widget state", () => {
      const digitalHeight = 360 * (88 / 224);
      const analogClock: WidgetInstance = {
        id: "00000000-0000-0000-0000-000000000004",
        type: "clock",
        x: 100,
        y: 50,
        z: 3,
        width: 300,
        height: 300,
        state: {
          __sizeByProfile: {
            "264x104": { width: 360, height: digitalHeight },
          },
        },
      };

      const [analogItem] = homeWidgetsToLayoutItems([analogClock]);
      expect(analogItem.widgetState).toEqual({
        __sizeByProfile: {
          "264x104": { width: 360, height: digitalHeight },
        },
      });

      const [restoredAnalog] = layoutItemsToHomeWidgets([analogItem]);
      expect(restoredAnalog).toMatchObject({
        state: {
          __sizeByProfile: {
            "264x104": { width: 360, height: digitalHeight },
          },
        },
        width: 300,
        height: 300,
      });

      const digitalClock: WidgetInstance = {
        ...restoredAnalog,
        state: {
          ...restoredAnalog.state,
          mode: "digital",
          __sizeByProfile: {
            "240x240": { width: 300, height: 300 },
          },
        },
        width: 360,
        height: digitalHeight,
      };

      const [digitalItem] = homeWidgetsToLayoutItems([digitalClock]);
      expect(digitalItem.targetId).toBe(
        "widget:00000000-0000-0000-0000-000000000004:digital",
      );
      expect(digitalItem.widgetState).toEqual({
        __sizeByProfile: {
          "240x240": { width: 300, height: 300 },
        },
      });

      const [restoredDigital] = layoutItemsToHomeWidgets([digitalItem]);
      expect(restoredDigital).toMatchObject({
        state: {
          mode: "digital",
          __sizeByProfile: {
            "240x240": { width: 300, height: 300 },
          },
        },
        width: 360,
      });
      expect(restoredDigital.height).toBeCloseTo(digitalHeight);
    });
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
