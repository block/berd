import type { CapabilityDescriptor } from "@/app/capabilities/types";
export type TerminalRenderMode = "docked" | "floating";

export const terminalCapabilityDescriptor = {
  id: "terminal",
  name: "Terminal",
  description:
    "Run shell sessions with tabs, command routing, and flexible placement.",
  owningFeature: "terminal",
  renderModes: ["docked", "floating"],
  requiredContext: ["sessionId", "workingDirectory"],
  states: [
    "unavailable",
    "starting",
    "running",
    "exited",
    "error",
    "collapsed",
    "expanded",
  ],
  actions: [
    "open",
    "collapse",
    "expand",
    "addTab",
    "selectTab",
    "restart",
    "stop",
    "runCommand",
    "popOut",
    "dockToBottom",
  ],
} as const satisfies CapabilityDescriptor<TerminalRenderMode>;
