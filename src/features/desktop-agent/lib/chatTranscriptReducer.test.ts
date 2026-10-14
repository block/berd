// Ported from the prototype's test/chat/chat_transcript_reducer_test.dart — same cases
// (minus the AcpRpcError hint test, which belongs to the session layer).

import { describe, expect, test } from "vitest";

import { AcpUpdate, type AcpNotification } from "./acpNotification";
import { emptyRuntime, plainText, type QueuedPrompt } from "./chatModels";
import { ChatTranscriptReducer } from "./chatTranscriptReducer";

function textNotification(
  kind: string,
  messageId: string,
  text: string,
  audience?: string[],
): AcpNotification {
  return {
    sessionId: "s1",
    update: new AcpUpdate({
      sessionUpdate: kind,
      messageId,
      content: {
        type: "text",
        text,
        ...(audience ? { annotations: { audience } } : {}),
      },
    }),
  };
}

describe("ChatTranscriptReducer", () => {
  test("assistant chunks append to a stable message", () => {
    const reducer = new ChatTranscriptReducer({
      messages: [],
      runtime: emptyRuntime(),
    });

    reducer.apply(textNotification("agent_message_chunk", "m1", "Hello"));
    const result = reducer.apply(
      textNotification("agent_message_chunk", "m1", " world"),
    );

    expect(reducer.messages).toHaveLength(1);
    expect(reducer.messages[0].id).toBe("m1");
    expect(plainText(reducer.messages[0])).toBe("Hello world");
    expect(result.subtitle).toBe("Hello world");
  });

  test("assistant-only user replay chunks are hidden", () => {
    const reducer = new ChatTranscriptReducer({
      messages: [],
      runtime: emptyRuntime(),
    });

    const result = reducer.apply(
      textNotification("user_message_chunk", "u1", "hidden context", [
        "assistant",
      ]),
    );

    expect(reducer.messages).toHaveLength(0);
    expect(result.subtitle).toBeUndefined();
  });

  test("session info with null active run ends streaming", () => {
    const reducer = new ChatTranscriptReducer({
      messages: [],
      runtime: emptyRuntime({ activeRunId: "run-1" }),
    });
    reducer.apply(textNotification("agent_message_chunk", "a1", "streaming"));

    reducer.apply({
      sessionId: "s1",
      update: new AcpUpdate({
        sessionUpdate: "session_info_update",
        _meta: { goose: { activeRunId: null } },
      }),
    });

    expect(reducer.runtime.streamingMessageId).toBeNull();
    expect(reducer.runtime.activeRunId).toBeNull();
    expect(reducer.messages[0].isStreaming).toBe(false);
  });

  test("authoritative replay preserves unreplayed local prompt", () => {
    const prompts: QueuedPrompt[] = [{ id: "local-1", text: "queued prompt" }];
    const replay = ChatTranscriptReducer.authoritativeReplay(
      [textNotification("agent_message_chunk", "a1", "loaded")],
      prompts,
    );

    expect(replay.messages.map((m) => m.id)).toEqual(["a1", "local-1"]);
    expect(replay.runtime.hasAuthoritativeReplay).toBe(true);
    expect(replay.runtime.isReplaying).toBe(false);
    expect(replay.queuedPrompts.map((p) => p.id)).toEqual(["local-1"]);
  });

  test("authoritative replay drops local prompts the replay contained", () => {
    const prompts: QueuedPrompt[] = [{ id: "local-1", text: "already there" }];
    const replay = ChatTranscriptReducer.authoritativeReplay(
      [textNotification("user_message", "server-1", "already there")],
      prompts,
    );

    expect(replay.messages.map((m) => m.id)).toEqual(["server-1"]);
    expect(replay.queuedPrompts).toHaveLength(0);
  });

  test("tool call and update flow", () => {
    const reducer = new ChatTranscriptReducer({
      messages: [],
      runtime: emptyRuntime(),
    });

    reducer.apply({
      sessionId: "s1",
      update: new AcpUpdate({
        sessionUpdate: "tool_call",
        messageId: "a1",
        toolCallId: "t1",
        title: "shell",
        status: "in_progress",
      }),
    });
    reducer.apply({
      sessionId: "s1",
      update: new AcpUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        result: "ok",
      }),
    });

    const tool = reducer.messages[0].content.find((c) => c.type === "tool");
    expect(tool?.type).toBe("tool");
    if (tool?.type === "tool") {
      expect(tool.tool.status).toBe("completed");
      expect(tool.tool.result).toBe("ok");
    }
  });

  test("replayed toolRequest/toolResponse blocks render as tool activity", () => {
    const reducer = new ChatTranscriptReducer({
      messages: [],
      runtime: emptyRuntime(),
    });
    reducer.apply({
      sessionId: "s1",
      update: new AcpUpdate({
        sessionUpdate: "agent_message",
        messageId: "req-1",
        content: {
          type: "toolRequest",
          id: "call-1",
          toolCall: { value: { name: "shell" } },
          _meta: { "goose.toolSummary.title": "running checks" },
        },
      }),
    });
    reducer.apply({
      sessionId: "s1",
      update: new AcpUpdate({
        sessionUpdate: "user_message",
        messageId: "res-1",
        content: {
          type: "toolResponse",
          id: "call-1",
          toolResult: {
            value: {
              isError: true,
              structuredContent: {
                stdout: "",
                stderr: "sh: just: command not found",
                exit_code: 127,
              },
            },
          },
        },
      }),
    });

    const tools = reducer.messages.flatMap((m) =>
      m.content.filter((c) => c.type === "tool"),
    );
    expect(tools).toHaveLength(2);
    expect(tools[0]?.type === "tool" && tools[0].tool.name).toBe(
      "running checks",
    );
    expect(tools[1]?.type === "tool" && tools[1].tool.status).toBe("failed");
    expect(tools[1]?.type === "tool" && tools[1].tool.result).toContain(
      "exit_code: 127",
    );
  });

  test("failed tool updates keep structured stdout/stderr for expansion", () => {
    const reducer = new ChatTranscriptReducer({
      messages: [],
      runtime: emptyRuntime(),
    });
    reducer.apply({
      sessionId: "s1",
      update: new AcpUpdate({
        sessionUpdate: "tool_call_update",
        messageId: "a1",
        toolCallId: "t1",
        title: "shell",
        status: "failed",
        result: {
          structuredContent: {
            stdout: "partial output",
            stderr: "sh: just: command not found",
            exit_code: 127,
          },
        },
      }),
    });

    const tool = reducer.messages[0].content.find((c) => c.type === "tool");
    expect(tool?.type).toBe("tool");
    if (tool?.type === "tool") {
      expect(tool.tool.status).toBe("failed");
      expect(tool.tool.result).toContain("exit_code: 127");
      expect(tool.tool.result).toContain("stdout:\npartial output");
      expect(tool.tool.result).toContain(
        "stderr:\nsh: just: command not found",
      );
    }
  });

  test("optimistic echo is not duplicated by server user_message", () => {
    const reducer = new ChatTranscriptReducer({
      messages: [],
      runtime: emptyRuntime(),
    });
    reducer.appendLocalUserMessage({ id: "opt-1", text: "hi there" });

    reducer.apply(textNotification("user_message", "server-9", "hi there"));

    expect(reducer.messages).toHaveLength(1);
    expect(reducer.messages[0].id).toBe("opt-1");
  });

  test("turn_complete settles streaming", () => {
    const reducer = new ChatTranscriptReducer({
      messages: [],
      runtime: emptyRuntime(),
    });
    reducer.apply(textNotification("agent_message_chunk", "a1", "partial"));
    expect(reducer.messages[0].isStreaming).toBe(true);

    reducer.apply({
      sessionId: "s1",
      update: new AcpUpdate({ sessionUpdate: "turn_complete" }),
    });

    expect(reducer.messages[0].isStreaming).toBe(false);
    expect(reducer.runtime.streamingMessageId).toBeNull();
  });
});
