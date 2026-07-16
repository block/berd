import { describe, expect, it } from "vitest";
import {
  resolveEffectiveNavigationSecondaryTarget,
  resolveNavigationPrototypePrimaryCollapsed,
  resolveNewConversationShortcutProjectId,
} from "./navigationPrototypeState";

describe("resolveNewConversationShortcutProjectId", () => {
  const baseInput = {
    activeSessionProjectId: null,
    activeView: "home" as const,
    navigationRefreshEnabled: true,
    secondaryCommitted: false,
    secondaryPreview: false,
    secondaryTarget: null,
  };

  it("prefers the active project chat over a previewed project", () => {
    expect(
      resolveNewConversationShortcutProjectId({
        ...baseInput,
        activeSessionProjectId: "project-a",
        activeView: "chat",
        secondaryPreview: true,
        secondaryTarget: { kind: "project", projectId: "project-b" },
      }),
    ).toBe("project-a");
  });

  it("ignores a previewed project without an active project chat", () => {
    expect(
      resolveNewConversationShortcutProjectId({
        ...baseInput,
        secondaryPreview: true,
        secondaryTarget: { kind: "project", projectId: "project-b" },
      }),
    ).toBeNull();
  });

  it("uses a committed project selection", () => {
    expect(
      resolveNewConversationShortcutProjectId({
        ...baseInput,
        secondaryCommitted: true,
        secondaryTarget: { kind: "project", projectId: "project-b" },
      }),
    ).toBe("project-b");
  });
});

describe("resolveEffectiveNavigationSecondaryTarget", () => {
  it("uses the active chat target when no secondary panel is explicitly selected", () => {
    expect(
      resolveEffectiveNavigationSecondaryTarget({
        activeChatNavigationSecondaryTarget: { kind: "chats" },
        activeSessionId: "session-1",
        navigationSecondarySuppressedSessionId: null,
        navigationSecondaryTarget: null,
      }),
    ).toEqual({ kind: "chats" });
  });

  it("suppresses the active chat fallback for the selected primary chat", () => {
    expect(
      resolveEffectiveNavigationSecondaryTarget({
        activeChatNavigationSecondaryTarget: { kind: "chats" },
        activeSessionId: "session-1",
        navigationSecondarySuppressedSessionId: "session-1",
        navigationSecondaryTarget: null,
      }),
    ).toBeNull();
  });

  it("lets an explicit secondary target override chat fallback suppression", () => {
    expect(
      resolveEffectiveNavigationSecondaryTarget({
        activeChatNavigationSecondaryTarget: { kind: "chats" },
        activeSessionId: "session-1",
        navigationSecondarySuppressedSessionId: "session-1",
        navigationSecondaryTarget: { kind: "settings" },
      }),
    ).toEqual({ kind: "settings" });
  });

  it("returns to suppressed chat fallback after an explicit target closes", () => {
    const suppressedSessionId = "session-1";

    expect(
      resolveEffectiveNavigationSecondaryTarget({
        activeChatNavigationSecondaryTarget: { kind: "chats" },
        activeSessionId: suppressedSessionId,
        navigationSecondarySuppressedSessionId: suppressedSessionId,
        navigationSecondaryTarget: { kind: "chats", variant: "more" },
      }),
    ).toEqual({ kind: "chats", variant: "more" });

    expect(
      resolveEffectiveNavigationSecondaryTarget({
        activeChatNavigationSecondaryTarget: { kind: "chats" },
        activeSessionId: suppressedSessionId,
        navigationSecondarySuppressedSessionId: suppressedSessionId,
        navigationSecondaryTarget: null,
      }),
    ).toBeNull();
  });
});

describe("resolveNavigationPrototypePrimaryCollapsed", () => {
  it("keeps hybrid prototype nav collapsed by default and expands only while primary is hovered", () => {
    expect(
      resolveNavigationPrototypePrimaryCollapsed({
        mode: "hybrid-push-overlay",
        navigationPrimaryHovered: false,
        prototypePrimaryRestCollapsed: false,
        prototypeSecondaryOpen: false,
      }),
    ).toBe(true);

    expect(
      resolveNavigationPrototypePrimaryCollapsed({
        mode: "hybrid-push-overlay",
        navigationPrimaryHovered: true,
        prototypePrimaryRestCollapsed: false,
        prototypeSecondaryOpen: false,
      }),
    ).toBe(false);
  });

  it("does not let secondary nav state expand hybrid prototype primary nav", () => {
    expect(
      resolveNavigationPrototypePrimaryCollapsed({
        mode: "hybrid-push-overlay",
        navigationPrimaryHovered: false,
        prototypePrimaryRestCollapsed: false,
        prototypeSecondaryOpen: true,
      }),
    ).toBe(true);
  });

  it("keeps the prototype primary nav expanded by default on the home canvas", () => {
    expect(
      resolveNavigationPrototypePrimaryCollapsed({
        mode: "hybrid-push-overlay",
        navigationPrimaryHovered: false,
        prototypePrimaryDefaultExpanded: true,
        prototypePrimaryRestCollapsed: false,
        prototypeSecondaryOpen: false,
      }),
    ).toBe(false);
  });

  it("keeps rest-collapsed chat state collapsed even when default-expanded is requested", () => {
    expect(
      resolveNavigationPrototypePrimaryCollapsed({
        mode: "hybrid-push-overlay",
        navigationPrimaryHovered: false,
        prototypePrimaryDefaultExpanded: true,
        prototypePrimaryRestCollapsed: true,
        prototypeSecondaryOpen: false,
      }),
    ).toBe(true);
  });

  it("expands rest-collapsed new chat primary nav while hovered", () => {
    expect(
      resolveNavigationPrototypePrimaryCollapsed({
        mode: "hybrid-push-overlay",
        navigationPrimaryHovered: true,
        prototypePrimaryRestCollapsed: true,
        prototypeSecondaryOpen: false,
      }),
    ).toBe(false);
  });
});
