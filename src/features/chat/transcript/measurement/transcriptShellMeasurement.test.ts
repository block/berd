import { describe, expect, it } from "vitest";
import type { Message, MessageContent } from "@/shared/types/messages";
import {
  VIRTUAL_ROW_MEASUREMENT_SHELL_ATTRIBUTE,
  VIRTUAL_ROW_RESERVED_BLOCK_SIZE_ATTRIBUTE,
  VIRTUAL_ROW_SHELL_BLOCK_ATTRIBUTE,
  VIRTUAL_ROW_SHELL_BLOCK_KIND_ATTRIBUTE,
  VIRTUAL_ROW_SHELL_KIND_ATTRIBUTE,
  canUseTranscriptShellMeasurement,
  createTranscriptShellBlockAttributes,
  createTranscriptShellMeasurementPlan,
  createTranscriptShellRootAttributes,
} from "./index";

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

describe("createTranscriptShellMeasurementPlan", () => {
  it("creates a side-effect-free shell plan for MCP app rows", () => {
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

    const plan = createTranscriptShellMeasurementPlan({
      rowKind: "message",
      message,
    });

    expect(plan.status).toBe("ready");
    expect(canUseTranscriptShellMeasurement(plan)).toBe(true);
    expect(plan.blocks).toMatchObject([
      {
        kind: "mcp-app",
        reservedBlockSize: 260,
        pendingReason: "mcp-iframe-sizing",
      },
    ]);
    expect(createTranscriptShellRootAttributes(plan)).toEqual({
      [VIRTUAL_ROW_MEASUREMENT_SHELL_ATTRIBUTE]: "true",
      [VIRTUAL_ROW_RESERVED_BLOCK_SIZE_ATTRIBUTE]: "260",
      [VIRTUAL_ROW_SHELL_KIND_ATTRIBUTE]: "message",
    });
  });

  it("does not create a shell plan when policy is estimate-only", () => {
    const message = createMessage([{ type: "text", text: "active app row" }]);

    const plan = createTranscriptShellMeasurementPlan({
      rowKind: "message",
      message,
      capabilities: { hasMcpApp: true },
      uiState: { hasActiveMcpHostRequest: true },
    });

    expect(plan.status).toBe("blocked");
    expect(canUseTranscriptShellMeasurement(plan)).toBe(false);
    expect(createTranscriptShellRootAttributes(plan)).toEqual({});
  });

  it("includes metadata and dynamic content shell blocks in estimated size", () => {
    const message = createMessage(
      [
        { type: "text", text: "hello" },
        {
          type: "image",
          data: "data:image/png;base64,abc",
          mimeType: "image/png",
        },
      ],
      {
        metadata: {
          attachments: [{ type: "file", name: "notes.txt", path: "notes.txt" }],
          chips: [{ type: "skill", label: "Review" }],
        },
      },
    );

    const plan = createTranscriptShellMeasurementPlan({
      rowKind: "message",
      message,
    });

    expect(plan.status).toBe("ready");
    expect(plan.estimatedBlockSize).toBeGreaterThan(96);
    expect(plan.blocks.map((block) => block.kind)).toEqual([
      "attachment-strip",
      "chip-strip",
      "text",
      "image",
    ]);
    const imageBlock = plan.blocks.find((block) => block.kind === "image");
    expect(imageBlock).toBeDefined();
    if (!imageBlock) {
      throw new Error("Expected image shell block");
    }

    expect(createTranscriptShellBlockAttributes(imageBlock)).toEqual({
      [VIRTUAL_ROW_RESERVED_BLOCK_SIZE_ATTRIBUTE]: "220",
      [VIRTUAL_ROW_SHELL_BLOCK_ATTRIBUTE]: "true",
      [VIRTUAL_ROW_SHELL_BLOCK_KIND_ATTRIBUTE]: "image",
    });
  });

  it("does not expose source transcript text through shell metadata attributes", () => {
    const secretToken = "offscreen-shell-token-should-not-be-searchable";
    const message = createMessage([
      {
        type: "text",
        text: `Visible transcript source ${secretToken}`,
      },
    ]);

    const plan = createTranscriptShellMeasurementPlan({
      rowKind: "message",
      message,
    });
    const serializedShellMetadata = JSON.stringify({
      root: createTranscriptShellRootAttributes(plan),
      blocks: plan.blocks.map((block) => ({
        block,
        attributes: createTranscriptShellBlockAttributes(block),
      })),
    });

    expect(plan.status).toBe("ready");
    expect(serializedShellMetadata).not.toContain(secretToken);
  });
});
