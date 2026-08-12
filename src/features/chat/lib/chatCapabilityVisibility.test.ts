import { describe, expect, it } from "vitest";
import type { ChatSession } from "../stores/chatSessionStore";
import {
  isAgentBuilderVisible,
  isContextPanelVisible,
} from "./chatCapabilityVisibility";

const builderSession = {
  id: "session-1",
  title: "New agent",
  createdAt: "2026-07-30T00:00:00.000Z",
  updatedAt: "2026-07-30T00:00:00.000Z",
  messageCount: 0,
  intent: "build-agent",
} satisfies ChatSession;

describe("chat capability visibility", () => {
  it("treats a legacy builder session without a visibility flag as open", () => {
    expect(isAgentBuilderVisible(builderSession)).toBe(true);
    expect(isContextPanelVisible(builderSession, true)).toBe(false);
  });

  it("shows Context when the user reopens it beside Agent Builder", () => {
    expect(
      isContextPanelVisible(
        { ...builderSession, agentBuilderContextState: "userOpened" },
        true,
      ),
    ).toBe(true);
  });

  it("suppresses Agent Builder and uses ordinary Context state when read-only", () => {
    expect(isAgentBuilderVisible(builderSession, { readOnly: true })).toBe(
      false,
    );
    expect(
      isContextPanelVisible(builderSession, true, { readOnly: true }),
    ).toBe(true);
  });
});
