import { describe, expect, it, vi } from "vitest";
import {
  getAgentTerminalTabState,
  setAgentTerminalTabState,
  subscribeAgentTerminalTabState,
} from "./acpTerminalTabState";

const placement = {
  kind: "docked" as const,
  region: "chatColumn" as const,
  slot: "bottom" as const,
  size: { height: 300 },
};

describe("ACP terminal tab state", () => {
  it("keeps live agent tabs available across controller unmounts", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAgentTerminalTabState("session-1", listener);
    const tab = {
      id: "command-1",
      cwd: "/repo",
      title: "pnpm dev",
      source: "agent" as const,
    };

    setAgentTerminalTabState("session-1", {
      tabs: [tab],
      activeTabId: tab.id,
      expanded: true,
      placement,
    });
    unsubscribe();

    expect(getAgentTerminalTabState("session-1")).toEqual({
      tabs: [tab],
      activeTabId: tab.id,
      expanded: true,
      placement,
    });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("isolates sessions and clears empty state", () => {
    setAgentTerminalTabState("session-a", {
      tabs: [
        {
          id: "command-1",
          cwd: "/a",
          title: "a",
          source: "agent",
        },
      ],
      activeTabId: "command-1",
      expanded: true,
      placement,
    });
    expect(getAgentTerminalTabState("session-b").tabs).toEqual([]);

    setAgentTerminalTabState("session-a", {
      tabs: [],
      activeTabId: null,
      expanded: false,
      placement,
    });
    expect(getAgentTerminalTabState("session-a").tabs).toEqual([]);
  });
});
