import { describe, expect, it } from "vitest";
import {
  getSubagentToolCallInfo,
  resolveDelegateContextForTask,
  resolveDelegateSourceForTask,
  resolveSubagentContext,
  shortTaskId,
} from "@/features/chat/lib/subagentToolCalls";
import type { MessageContent } from "@/shared/types/messages";

describe("getSubagentToolCallInfo", () => {
  it("returns undefined without a wire tool name", () => {
    expect(
      getSubagentToolCallInfo({ arguments: { source: "20260807_72" } }),
    ).toBeUndefined();
  });

  it("returns undefined for unrelated tools", () => {
    expect(
      getSubagentToolCallInfo({
        toolName: "developer__shell",
        arguments: { command: "ls" },
      }),
    ).toBeUndefined();
  });

  describe("goose delegate", () => {
    it("keeps the source as agent name, separate from the task label", () => {
      expect(
        getSubagentToolCallInfo({
          toolName: "delegate",
          arguments: {
            source: "code-reviewer",
            instructions: "Review the auth module",
            async: true,
          },
        }),
      ).toEqual({
        activity: "delegating",
        agentName: "code-reviewer",
        label: "Review the auth module",
      });
    });

    it("classifies delegate with only a source (no instructions)", () => {
      expect(
        getSubagentToolCallInfo({
          toolName: "delegate",
          arguments: { source: "code-reviewer", async: true },
        }),
      ).toEqual({
        activity: "delegating",
        agentName: "code-reviewer",
        sourceDefinesTask: true,
      });
    });

    it("uses instructions as the label and truncates long labels", () => {
      const instructions =
        "Research task (read-only, no edits): Investigate how the Goose agent backend emits tool calls";
      const info = getSubagentToolCallInfo({
        toolName: "delegate",
        arguments: { instructions },
      });
      expect(info?.activity).toBe("delegating");
      expect(info?.label?.length).toBeLessThanOrEqual(60);
      expect(info?.label?.endsWith("…")).toBe(true);
    });

    it("does not classify a delegate with no task boundary", () => {
      expect(
        getSubagentToolCallInfo({ toolName: "delegate", arguments: {} }),
      ).toBeUndefined();
    });
  });

  describe("goose load", () => {
    it("classifies load with a task id as waiting", () => {
      expect(
        getSubagentToolCallInfo({
          toolName: "load",
          arguments: { source: "20260807_72" },
        }),
      ).toEqual({ activity: "waiting", taskId: "20260807_72" });
    });

    it("classifies peek as checking", () => {
      expect(
        getSubagentToolCallInfo({
          toolName: "load",
          arguments: { source: "20260807_72", peek: true },
        }),
      ).toEqual({ activity: "checking", taskId: "20260807_72" });
    });

    it("classifies cancel as cancelling (over peek)", () => {
      expect(
        getSubagentToolCallInfo({
          toolName: "load",
          arguments: { source: "20260807_72", cancel: true, peek: true },
        }),
      ).toEqual({ activity: "cancelling", taskId: "20260807_72" });
    });

    it("does not classify load of a named source (recipe/skill)", () => {
      expect(
        getSubagentToolCallInfo({
          toolName: "load",
          arguments: { source: "deploy" },
        }),
      ).toBeUndefined();
    });

    it("does not classify a source listing (no source)", () => {
      expect(
        getSubagentToolCallInfo({ toolName: "load", arguments: {} }),
      ).toBeUndefined();
    });
  });

  describe("claude code Task", () => {
    it("treats general-purpose as anonymous, keeping the description", () => {
      expect(
        getSubagentToolCallInfo({
          toolName: "Task",
          arguments: {
            subagent_type: "general-purpose",
            description: "Find auth bugs",
            prompt: "Look through src/ for auth issues",
          },
        }),
      ).toEqual({ activity: "delegating", label: "Find auth bugs" });
    });

    it("keeps a named subagent_type as agent name alongside the task", () => {
      expect(
        getSubagentToolCallInfo({
          toolName: "Task",
          arguments: {
            subagent_type: "code-reviewer",
            description: "Review the auth module",
          },
        }),
      ).toEqual({
        activity: "delegating",
        agentName: "code-reviewer",
        label: "Review the auth module",
      });
    });

    it("does not classify an agent when description is absent", () => {
      expect(
        getSubagentToolCallInfo({
          toolName: "Agent",
          arguments: {
            subagent_type: "code-reviewer",
            prompt: "Review the authentication boundary",
          },
        }),
      ).toBeUndefined();
    });

    it("does not classify a named agent without a task description", () => {
      expect(
        getSubagentToolCallInfo({
          toolName: "Agent",
          arguments: { subagent_type: "code-reviewer" },
        }),
      ).toBeUndefined();
    });
  });

  describe("resolveDelegateSourceForTask", () => {
    const transcript = (
      blocks: MessageContent[][],
    ): Array<{ content: MessageContent[] }> =>
      blocks.map((content) => ({ content }));

    const delegateRequest = (
      id: string,
      args: Record<string, unknown>,
    ): MessageContent => ({
      type: "toolRequest",
      id,
      name: "delegate",
      toolName: "delegate",
      arguments: args,
      status: "completed",
    });

    const delegateResponse = (
      id: string,
      result: string,
      structuredContent?: unknown,
    ): MessageContent => ({
      type: "toolResponse",
      id,
      name: "delegate",
      result,
      ...(structuredContent !== undefined ? { structuredContent } : {}),
      isError: false,
    });

    it("resolves the source of the delegate that announced the task id", () => {
      const messages = transcript([
        [
          delegateRequest("call-1", { source: "Rivet", async: true }),
          delegateResponse(
            "call-1",
            'Task 20260807_119 started in background: "count files"',
          ),
        ],
        [
          delegateRequest("call-2", { source: "Vogue", async: true }),
          delegateResponse(
            "call-2",
            'Task 20260807_120 started in background: "read readme"',
          ),
        ],
      ]);
      expect(resolveDelegateSourceForTask(messages, "20260807_119")).toBe(
        "Rivet",
      );
      expect(resolveDelegateSourceForTask(messages, "20260807_120")).toBe(
        "Vogue",
      );
    });

    it("finds the task id in structured content", () => {
      const messages = transcript([
        [
          delegateRequest("call-1", { source: "Trace", async: true }),
          delegateResponse("call-1", "started", {
            subagent_session_id: "20260807_119",
          }),
        ],
      ]);
      expect(resolveDelegateSourceForTask(messages, "20260807_119")).toBe(
        "Trace",
      );
    });

    it("does not match a task id that is a prefix of another (7 vs 72)", () => {
      const messages = transcript([
        [
          delegateRequest("call-1", { source: "Rivet", async: true }),
          delegateResponse(
            "call-1",
            'Task 20260807_72 started in background: "count files"',
          ),
        ],
      ]);
      // 20260807_7 is a prefix of 20260807_72; it must NOT resolve to Rivet.
      expect(
        resolveDelegateSourceForTask(messages, "20260807_7"),
      ).toBeUndefined();
      expect(resolveDelegateSourceForTask(messages, "20260807_72")).toBe(
        "Rivet",
      );
    });

    it("does not prefix-match inside structured content", () => {
      const messages = transcript([
        [
          delegateRequest("call-1", { source: "Trace", async: true }),
          delegateResponse("call-1", "started", {
            subagent_session_id: "20260807_119",
          }),
        ],
      ]);
      expect(
        resolveDelegateSourceForTask(messages, "20260807_11"),
      ).toBeUndefined();
    });

    it("retains both identity and task for async follow-ups", () => {
      const messages = transcript([
        [
          delegateRequest("call-1", {
            source: "Rivet",
            instructions: "Count markdown files",
            async: true,
          }),
          delegateResponse(
            "call-1",
            'Task 20260807_119 started in background: "Count markdown files"',
          ),
        ],
      ]);
      expect(resolveDelegateContextForTask(messages, "20260807_119")).toEqual({
        subagentAgentName: "Rivet",
        subagentTaskLabel: "Count markdown files",
      });
    });

    it("retains a named source's configured task for async follow-ups", () => {
      const messages = transcript([
        [
          delegateRequest("call-1", { source: "Rivet", async: true }),
          delegateResponse("call-1", "Task 20260807_120 started in background"),
        ],
      ]);
      expect(resolveDelegateContextForTask(messages, "20260807_120")).toEqual({
        subagentAgentName: "Rivet",
        subagentTaskIsConfigured: true,
      });
    });

    it("returns undefined for ad-hoc delegates (no source)", () => {
      const messages = transcript([
        [
          delegateRequest("call-1", { instructions: "do a thing" }),
          delegateResponse(
            "call-1",
            'Task 20260807_119 started in background: "do a thing"',
          ),
        ],
      ]);
      expect(
        resolveDelegateSourceForTask(messages, "20260807_119"),
      ).toBeUndefined();
    });

    it("returns undefined when no delegate mentions the task id", () => {
      expect(resolveDelegateSourceForTask([], "20260807_119")).toBeUndefined();
    });
  });

  describe("resolveSubagentContext", () => {
    it("only resolves for load calls with a task-id source", () => {
      expect(
        resolveSubagentContext("load", { source: "deploy" }, []),
      ).toBeUndefined();
      expect(
        resolveSubagentContext("delegate", { source: "Rivet" }, []),
      ).toBeUndefined();
      expect(resolveSubagentContext(undefined, {}, [])).toBeUndefined();
    });
  });

  describe("shortTaskId", () => {
    it("drops the date prefix", () => {
      expect(shortTaskId("20260807_72")).toBe("72");
    });

    it("passes unexpected values through unchanged", () => {
      expect(shortTaskId("no-separator")).toBe("no-separator");
    });
  });

  describe("codex spawn_agent", () => {
    it("classifies spawn_agent with a prompt label", () => {
      expect(
        getSubagentToolCallInfo({
          toolName: "spawn_agent",
          arguments: { prompt: "Investigate the failing tests" },
        }),
      ).toEqual({
        activity: "delegating",
        label: "Investigate the failing tests",
      });
    });
    it("does not classify spawn_agent without a prompt", () => {
      expect(
        getSubagentToolCallInfo({
          toolName: "spawn_agent",
          arguments: {},
        }),
      ).toBeUndefined();
    });
  });
});
