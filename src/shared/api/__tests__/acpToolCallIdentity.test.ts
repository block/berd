import { describe, expect, it } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { getToolCallIdentity } from "@/shared/api/acpToolCallIdentity";

function toolCallUpdate(meta: Record<string, unknown>): SessionUpdate {
  return {
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    title: "Some title",
    _meta: meta,
  } as SessionUpdate;
}

describe("getToolCallIdentity", () => {
  it("returns empty without _meta", () => {
    expect(
      getToolCallIdentity({
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "Some title",
      } as SessionUpdate),
    ).toEqual({});
  });

  it("extracts goose tool call identity", () => {
    expect(
      getToolCallIdentity(
        toolCallUpdate({
          goose: {
            toolCall: { toolName: "delegate", extensionName: "summon" },
          },
        }),
      ),
    ).toEqual({ toolName: "delegate", extensionName: "summon" });
  });

  it("prefers goose mcpApp identity over toolCall", () => {
    expect(
      getToolCallIdentity(
        toolCallUpdate({
          goose: {
            mcpApp: { toolName: "app-tool" },
            toolCall: { toolName: "other" },
          },
        }),
      ),
    ).toEqual({ toolName: "app-tool" });
  });

  it("extracts Claude Code tool names", () => {
    expect(
      getToolCallIdentity(toolCallUpdate({ claudeCode: { toolName: "Task" } })),
    ).toEqual({ toolName: "Task" });
  });

  it("extracts Codex collaboration tool names", () => {
    expect(
      getToolCallIdentity(
        toolCallUpdate({
          codex: { collaboration: { tool: "spawn_agent" } },
        }),
      ),
    ).toEqual({ toolName: "spawn_agent" });
  });

  it("reads Claude Code identity when _meta.goose carries only replay fields", () => {
    // Replay stamps `_meta.goose` (messageId/created) on updates for any
    // harness; that must not shadow the vendor identity namespaces.
    expect(
      getToolCallIdentity(
        toolCallUpdate({
          goose: { messageId: "msg-1", created: 1754620000000 },
          claudeCode: { toolName: "Task" },
        }),
      ),
    ).toEqual({ toolName: "Task" });
  });

  it("reads Codex identity when _meta.goose carries only replay fields", () => {
    expect(
      getToolCallIdentity(
        toolCallUpdate({
          goose: { messageId: "msg-1" },
          codex: { collaboration: { tool: "spawn_agent" } },
        }),
      ),
    ).toEqual({ toolName: "spawn_agent" });
  });

  it("prefers goose tool identity over other vendors when both exist", () => {
    expect(
      getToolCallIdentity(
        toolCallUpdate({
          goose: { toolCall: { toolName: "delegate" } },
          claudeCode: { toolName: "Task" },
        }),
      ),
    ).toEqual({ toolName: "delegate" });
  });

  it("returns empty for malformed vendor metadata", () => {
    expect(
      getToolCallIdentity(
        toolCallUpdate({
          goose: { toolCall: "not-a-record" },
          claudeCode: { toolName: 42 },
          codex: { collaboration: { tool: null } },
        }),
      ),
    ).toEqual({});
  });
});
