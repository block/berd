import { describe, expect, test } from "vitest";

import type { ChatMessage } from "./chatModels";
import {
  groupTranscript,
  stripWirePreamble,
  toolDisplayName,
  toolGlyph,
  toolResultText,
} from "./transcriptDisplay";

const msg = (
  id: string,
  content: ChatMessage["content"],
  role: "user" | "assistant" = "assistant",
): ChatMessage => ({
  id,
  role,
  content,
  isStreaming: false,
  createdAt: 0,
});

const tool = (id: string, name: string, status: string) => ({
  type: "tool" as const,
  tool: { id, name, status },
});

describe("groupTranscript", () => {
  test("consecutive tool-only messages collapse into one toolRun", () => {
    const items = groupTranscript([
      msg("u1", [{ type: "text", text: "do the thing" }], "user"),
      msg("a1", [tool("t1", "shell", "completed")]),
      msg("a2", [tool("t2", "shell", "completed")]),
      msg("a3", [tool("t3", "shell", "failed")]),
      msg("a4", [{ type: "text", text: "done!" }]),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["message", "toolRun", "message"]);
    const run = items[1];
    expect(run.kind === "toolRun" && run.tools.map((t) => t.id)).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
  });

  test("mixed content (text + tool) renders as a normal message, breaking the run", () => {
    const items = groupTranscript([
      msg("a1", [tool("t1", "shell", "completed")]),
      msg("a2", [
        { type: "text", text: "thinking…" },
        tool("t2", "shell", "completed"),
      ]),
      msg("a3", [tool("t3", "shell", "completed")]),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["toolRun", "message", "toolRun"]);
  });

  test("empty content (streaming placeholder) is a message, not a run", () => {
    const items = groupTranscript([msg("a1", [])]);
    expect(items[0].kind).toBe("message");
  });

  test("multiple tools inside one message join the run", () => {
    const items = groupTranscript([
      msg("a1", [
        tool("t1", "shell", "completed"),
        tool("t2", "shell", "completed"),
      ]),
      msg("a2", [tool("t3", "shell", "completed")]),
    ]);
    expect(items).toHaveLength(1);
    const run = items[0];
    expect(run.kind === "toolRun" && run.tools).toHaveLength(3);
  });

  test("replay request/response pair with the same id merges into one tool row", () => {
    const items = groupTranscript([
      msg("a1", [tool("call-1", "shell", "in_progress")]),
      msg("a2", [
        {
          type: "tool",
          tool: {
            id: "call-1",
            name: "Tool result",
            status: "failed",
            result: "boom",
          },
        },
      ]),
    ]);
    expect(items).toHaveLength(1);
    const run = items[0];
    expect(run.kind === "toolRun" && run.tools).toHaveLength(1);
    expect(run.kind === "toolRun" && run.tools[0]).toMatchObject({
      id: "call-1",
      name: "shell",
      status: "failed",
      result: "boom",
    });
  });

  test("run key is stable across regroups (first message id)", () => {
    const messages = [
      msg("a7", [tool("t1", "shell", "completed")]),
      msg("a8", [tool("t2", "shell", "in_progress")]),
    ];
    const a = groupTranscript(messages);
    const b = groupTranscript(messages);
    expect(a[0].kind === "toolRun" && a[0].key).toBe("tools-a7");
    expect(b[0].kind === "toolRun" && b[0].key).toBe("tools-a7");
  });
});

describe("tool display helpers", () => {
  test("status glyphs", () => {
    expect(toolGlyph("completed")).toBe("✓");
    expect(toolGlyph("failed")).toBe("✗");
    expect(toolGlyph("in_progress")).toBe("⋯");
  });

  test("result text trims empty output but preserves useful logs", () => {
    expect(
      toolResultText({ id: "t1", name: "shell", status: "failed" }),
    ).toBeNull();
    expect(
      toolResultText({
        id: "t1",
        name: "shell",
        status: "failed",
        result: "  boom\n",
      }),
    ).toBe("boom");
  });

  test("display name normalizes whitespace and falls back to Tool", () => {
    expect(
      toolDisplayName({
        id: "t1",
        name: " shell   command ",
        status: "completed",
      }),
    ).toBe("shell command");
    expect(
      toolDisplayName({ id: "t1", name: "   ", status: "completed" }),
    ).toBe("Tool");
  });
});

describe("stripWirePreamble", () => {
  test("strips the bracket line from a replayed perched send", () => {
    expect(
      stripWirePreamble(
        '[Perched on: Chrome — "TICKET-123"]\n\ncan you validate this issue',
      ),
    ).toBe("can you validate this issue");
  });

  test("strips the full-guidance preamble (bracket + guidance sentence)", () => {
    expect(
      stripWirePreamble(
        '[Perched on: Chrome — "Doc"]\nIf a skill of yours matches this window\u2019s content, prefer acting on the underlying artifact; any attached screenshot is visual context. Do not restate this notice.\n\nreal question here',
      ),
    ).toBe("real question here");
  });

  test("user text that merely mentions perching passes through", () => {
    expect(stripWirePreamble("I was perched on a chair")).toBe(
      "I was perched on a chair",
    );
  });

  test("preamble-shaped text without the blank-line gap passes through", () => {
    expect(stripWirePreamble("[Perched on: Chrome] no gap here")).toBe(
      "[Perched on: Chrome] no gap here",
    );
  });
});
