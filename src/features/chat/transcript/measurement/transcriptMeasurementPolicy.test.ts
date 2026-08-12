import { describe, expect, it } from "vitest";
import type { Message, MessageContent } from "@/shared/types/messages";
import {
  classifyMessageContentSafety,
  classifyTranscriptMeasurementPolicy,
} from "./transcriptMeasurementPolicy";

function createMessage(
  content: MessageContent[],
  overrides: Partial<Message> = {},
): Message {
  return {
    id: "message-1",
    role: "assistant",
    created: 1,
    content,
    metadata: { userVisible: true },
    ...overrides,
  };
}

describe("classifyTranscriptMeasurementPolicy", () => {
  it("allows real offscreen measurement for static date separators", () => {
    const decision = classifyTranscriptMeasurementPolicy({
      rowKind: "date-separator",
    });

    expect(decision.policy).toBe("measure-real");
    expect(decision.capabilities.canOffscreenRenderReal).toBe(true);
    expect(decision.layoutPendingPolicy).toBe("can-finalize");
    expect(decision.reasons).toContain("date-separator");
  });

  it("allows real offscreen measurement for static system notices", () => {
    const message = createMessage(
      [
        {
          type: "systemNotification",
          notificationType: "info",
          text: "Compacted context.",
        },
      ],
      { role: "system" },
    );

    const decision = classifyTranscriptMeasurementPolicy({
      rowKind: "message",
      message,
    });

    expect(decision.policy).toBe("measure-real");
    expect(decision.reasons).toContain("static-system-notice");
  });

  it("keeps unaudited whole text rows on shell measurement", () => {
    const message = createMessage([{ type: "text", text: "hello" }]);

    const decision = classifyTranscriptMeasurementPolicy({
      rowKind: "message",
      message,
    });

    expect(decision.policy).toBe("measure-shell");
    expect(decision.capabilities.canOffscreenRenderShell).toBe(true);
    expect(decision.reasons).toContain("text-row-requires-audit");
  });

  it("allows completed stateless fragments to measure real content", () => {
    const decision = classifyTranscriptMeasurementPolicy({
      rowKind: "assistant-content-fragment",
      content: [{ type: "text", text: "completed fragment" }],
    });

    expect(decision.policy).toBe("measure-real");
    expect(decision.reasons).toContain("side-effect-free-fragment");
  });

  it("uses shell measurement for inactive MCP app rows", () => {
    const message = createMessage([
      {
        type: "mcpApp",
        id: "app-1",
        payload: {
          sessionId: "session-1",
          toolCallId: "tool-1",
          toolCallTitle: "Preview",
          source: "toolCallUpdateMeta",
          tool: {
            name: "preview",
            extensionName: "mcp",
            resourceUri: "ui://preview",
          },
          resource: { result: null },
        },
      },
    ]);

    const decision = classifyTranscriptMeasurementPolicy({
      rowKind: "message",
      message,
    });

    expect(decision.policy).toBe("measure-shell");
    expect(decision.layoutPendingPolicy).toBe("requires-stable-descendants");
    expect(decision.capabilities.hasMcpApp).toBe(true);
    expect(decision.capabilities.hasHostCalls).toBe(true);
    expect(decision.capabilities.canOffscreenRenderReal).toBe(false);
    expect(decision.reasons).toEqual(
      expect.arrayContaining(["mcp-app", "host-calls"]),
    );
  });

  it("blocks offscreen rendering for active MCP host work", () => {
    const decision = classifyTranscriptMeasurementPolicy({
      rowKind: "message",
      content: [{ type: "text", text: "app row shell" }],
      capabilities: { hasMcpApp: true },
      uiState: { hasActiveMcpHostRequest: true },
    });

    expect(decision.policy).toBe("estimate-only");
    expect(decision.keepAlivePriority).toBe("active-mcp");
    expect(decision.capabilities.canOffscreenRenderShell).toBe(false);
    expect(decision.reasons).toContain("active-mcp-host-work");
  });

  it("blocks offscreen rendering for active tool timers", () => {
    const message = createMessage([
      {
        type: "toolRequest",
        id: "tool-1",
        name: "scan",
        arguments: {},
        status: "in_progress",
        startedAt: 100,
      },
    ]);

    const decision = classifyTranscriptMeasurementPolicy({
      rowKind: "message",
      message,
    });

    expect(decision.policy).toBe("estimate-only");
    expect(decision.keepAlivePriority).toBe("active-stream");
    expect(decision.capabilities.hasActiveTimer).toBe(true);
    expect(decision.reasons).toEqual(
      expect.arrayContaining(["active-tool", "active-timer"]),
    );
  });

  it("uses shell measurement for completed tool content", () => {
    const message = createMessage([
      {
        type: "toolResponse",
        id: "tool-1",
        name: "scan",
        result: "done",
        isError: false,
      },
    ]);

    const decision = classifyTranscriptMeasurementPolicy({
      rowKind: "message",
      message,
    });

    expect(decision.policy).toBe("measure-shell");
    expect(decision.capabilities.hasToolContent).toBe(true);
    expect(decision.reasons).toContain("tool-content");
  });

  it("blocks offscreen rendering for focus, selection, and open overlays", () => {
    const decision = classifyTranscriptMeasurementPolicy({
      rowKind: "message",
      content: [{ type: "text", text: "selected row" }],
      uiState: {
        hasFocusedDescendant: true,
        protectsSelection: true,
        hasOpenPopover: true,
      },
    });

    expect(decision.policy).toBe("estimate-only");
    expect(decision.keepAlivePriority).toBe("focused");
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        "focused-row",
        "active-selection",
        "open-overlay",
      ]),
    );
  });

  it.each([
    {
      name: "host action handlers",
      input: {
        rowKind: "message" as const,
        content: [{ type: "text" as const, text: "open this file" }],
        capabilities: { hasHostActionHandlers: true },
      },
      reason: "host-action-handlers",
    },
    {
      name: "image content",
      input: {
        rowKind: "message" as const,
        message: createMessage([
          {
            type: "image" as const,
            data: "data:image/png;base64,abc",
            mimeType: "image/png",
          },
        ]),
      },
      reason: "image-content",
    },
    {
      name: "completed tool trees",
      input: {
        rowKind: "message" as const,
        message: createMessage([
          {
            type: "toolResponse" as const,
            id: "tool-1",
            name: "scan",
            result: "done",
            isError: false,
          },
        ]),
      },
      reason: "tool-content",
    },
    {
      name: "reasoning widgets",
      input: {
        rowKind: "message" as const,
        message: createMessage([
          {
            type: "reasoning" as const,
            text: "private reasoning",
          },
        ]),
      },
      reason: "reasoning-or-thinking",
    },
    {
      name: "action-required widgets",
      input: {
        rowKind: "message" as const,
        message: createMessage([
          {
            type: "actionRequired" as const,
            id: "action-1",
            actionType: "toolConfirmation" as const,
            message: "Approve action",
          },
        ]),
      },
      reason: "action-required",
    },
    {
      name: "active nested MCP tool requests",
      input: {
        rowKind: "message" as const,
        content: [{ type: "text" as const, text: "app is working" }],
        capabilities: { hasMcpApp: true },
        uiState: { hasActiveNestedToolRequest: true },
      },
      reason: "active-nested-tool-request",
    },
    {
      name: "active copy feedback",
      input: {
        rowKind: "message" as const,
        content: [{ type: "text" as const, text: "copied row" }],
        uiState: { hasCopyFeedback: true },
      },
      reason: "active-copy-feedback",
    },
    {
      name: "unknown unsafe descendants",
      input: {
        rowKind: "message" as const,
        content: [{ type: "text" as const, text: "unknown widget" }],
        uiState: { hasUnknownUnsafeDescendants: true },
      },
      reason: "unknown-unsafe-descendant",
    },
  ])("does not allow real hidden measurement for $name", ({
    input,
    reason,
  }) => {
    const decision = classifyTranscriptMeasurementPolicy(input);

    expect(decision.policy).not.toBe("measure-real");
    expect(decision.capabilities.canOffscreenRenderReal).toBe(false);
    expect(decision.reasons).toContain(reason);
  });

  it.each([
    {
      name: "inactive MCP app",
      input: {
        rowKind: "message" as const,
        message: createMessage([
          {
            type: "mcpApp" as const,
            id: "app-1",
            payload: {
              sessionId: "session-1",
              toolCallId: "tool-1",
              toolCallTitle: "Preview",
              source: "toolCallUpdateMeta" as const,
              tool: {
                name: "preview",
                extensionName: "mcp",
                resourceUri: "ui://preview",
              },
              resource: { result: null },
            },
          },
        ]),
      },
      policy: "measure-shell",
      canUseShell: true,
      reasons: ["mcp-app", "host-calls"],
    },
    {
      name: "active tool timer",
      input: {
        rowKind: "message" as const,
        message: createMessage([
          {
            type: "toolRequest" as const,
            id: "tool-1",
            name: "scan",
            arguments: {},
            status: "in_progress" as const,
            startedAt: 100,
          },
        ]),
      },
      policy: "estimate-only",
      canUseShell: false,
      reasons: ["active-tool", "active-timer"],
    },
    {
      name: "focused row",
      input: {
        rowKind: "message" as const,
        content: [{ type: "text" as const, text: "focused row" }],
        uiState: { hasFocusedDescendant: true },
      },
      policy: "estimate-only",
      canUseShell: false,
      reasons: ["focused-row"],
    },
    {
      name: "selected row",
      input: {
        rowKind: "message" as const,
        content: [{ type: "text" as const, text: "selected row" }],
        uiState: { protectsSelection: true },
      },
      policy: "estimate-only",
      canUseShell: false,
      reasons: ["active-selection"],
    },
    {
      name: "open lightbox",
      input: {
        rowKind: "message" as const,
        content: [{ type: "text" as const, text: "lightbox row" }],
        uiState: { hasOpenLightbox: true },
      },
      policy: "estimate-only",
      canUseShell: false,
      reasons: ["open-overlay"],
    },
    {
      name: "active MCP host call",
      input: {
        rowKind: "message" as const,
        content: [{ type: "text" as const, text: "active app row" }],
        capabilities: { hasMcpApp: true },
        uiState: { hasActiveMcpHostRequest: true },
      },
      policy: "estimate-only",
      canUseShell: false,
      reasons: ["mcp-app", "active-mcp-host-work"],
    },
    {
      name: "unknown unsafe descendants",
      input: {
        rowKind: "message" as const,
        content: [{ type: "text" as const, text: "unknown widget" }],
        uiState: { hasUnknownUnsafeDescendants: true },
      },
      policy: "estimate-only",
      canUseShell: false,
      reasons: ["unknown-unsafe-descendant"],
    },
  ])("excludes $name from real hidden offscreen measurement", ({
    input,
    policy,
    canUseShell,
    reasons,
  }) => {
    const decision = classifyTranscriptMeasurementPolicy(input);

    expect(decision.policy).toBe(policy);
    expect(decision.capabilities.canOffscreenRenderReal).toBe(false);
    expect(decision.capabilities.canOffscreenRenderShell).toBe(canUseShell);
    expect(decision.reasons).toEqual(expect.arrayContaining(reasons));
  });

  it.each([
    {
      name: "MCP app rows",
      input: {
        rowKind: "message" as const,
        message: createMessage([
          {
            type: "mcpApp" as const,
            id: "app-1",
            payload: {
              sessionId: "session-1",
              toolCallId: "tool-1",
              toolCallTitle: "Preview",
              source: "toolCallUpdateMeta" as const,
              tool: {
                name: "preview",
                extensionName: "mcp",
                resourceUri: "ui://preview",
              },
              resource: { result: null },
            },
          },
        ]),
      },
      reasons: ["mcp-app", "host-calls"],
      keepAlivePriority: "none",
    },
    {
      name: "tool timer rows",
      input: {
        rowKind: "message" as const,
        message: createMessage([
          {
            type: "toolRequest" as const,
            id: "tool-1",
            name: "scan",
            arguments: {},
            status: "in_progress" as const,
            startedAt: 100,
          },
        ]),
      },
      reasons: ["active-tool", "active-timer"],
      keepAlivePriority: "active-stream",
    },
    {
      name: "focused rows",
      input: {
        rowKind: "message" as const,
        content: [{ type: "text" as const, text: "focused row" }],
        uiState: { hasFocusedDescendant: true },
      },
      reasons: ["focused-row"],
      keepAlivePriority: "focused",
    },
    {
      name: "selected rows",
      input: {
        rowKind: "message" as const,
        content: [{ type: "text" as const, text: "selected row" }],
        uiState: { protectsSelection: true },
      },
      reasons: ["active-selection"],
      keepAlivePriority: "selection",
    },
    {
      name: "open-overlay rows",
      input: {
        rowKind: "message" as const,
        content: [{ type: "text" as const, text: "overlay row" }],
        uiState: { hasOpenPopover: true },
      },
      reasons: ["open-overlay"],
      keepAlivePriority: "open-ui",
    },
    {
      name: "host-calling rows",
      input: {
        rowKind: "message" as const,
        content: [{ type: "text" as const, text: "host call" }],
        capabilities: { hasMcpApp: true },
        uiState: { hasActiveMcpHostRequest: true },
      },
      reasons: ["mcp-app", "active-mcp-host-work"],
      keepAlivePriority: "active-mcp",
    },
    {
      name: "unknown unsafe descendant rows",
      input: {
        rowKind: "message" as const,
        content: [{ type: "text" as const, text: "unknown descendant" }],
        uiState: { hasUnknownUnsafeDescendants: true },
      },
      reasons: ["unknown-unsafe-descendant"],
      keepAlivePriority: "none",
    },
  ])("never allows real hidden offscreen measurement for $name", ({
    input,
    reasons,
    keepAlivePriority,
  }) => {
    const decision = classifyTranscriptMeasurementPolicy(input);

    expect(decision.policy).not.toBe("measure-real");
    expect(decision.capabilities.canOffscreenRenderReal).toBe(false);
    expect(decision.keepAlivePriority).toBe(keepAlivePriority);
    expect(decision.reasons).toEqual(expect.arrayContaining(reasons));
  });
});

describe("classifyMessageContentSafety", () => {
  it("marks streaming text as dynamic layout with active-stream keepalive", () => {
    const message = createMessage([{ type: "text", text: "partial" }], {
      metadata: { completionStatus: "inProgress" },
    });

    const safety = classifyMessageContentSafety(message);

    expect(safety.layoutPendingPolicy).toBe("requires-stable-descendants");
    expect(safety.keepAlivePriority).toBe("active-stream");
    expect(safety.capabilities.hasStreamingContent).toBe(true);
    expect(safety.reasons).toEqual(
      expect.arrayContaining(["active-stream", "dynamic-async-layout"]),
    );
  });
});
