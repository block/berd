import { describe, expect, it } from "vitest";
import {
  getSubagentToolCallInfo,
  resolveDelegateContextForTask,
  resolveSubagentContext,
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

    it("classifies a delegate even when its task is unknown", () => {
      expect(
        getSubagentToolCallInfo({ toolName: "delegate", arguments: {} }),
      ).toEqual({ activity: "delegating" });
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

    it("uses prompt as the known task when description is absent", () => {
      expect(
        getSubagentToolCallInfo({
          toolName: "Agent",
          arguments: {
            subagent_type: "code-reviewer",
            prompt: "Review the authentication boundary",
          },
        }),
      ).toEqual({
        activity: "delegating",
        agentName: "code-reviewer",
        label: "Review the authentication boundary",
      });
    });

    it("retains known identity when the task is unknown", () => {
      expect(
        getSubagentToolCallInfo({
          toolName: "Agent",
          arguments: { subagent_type: "code-reviewer" },
        }),
      ).toEqual({ activity: "delegating", agentName: "code-reviewer" });
    });
  });

  describe("resolveDelegateContextForTask", () => {
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

    it("finds the exact task id in structured content", () => {
      const messages = transcript([
        [
          delegateRequest("call-1", { source: "Trace", async: true }),
          delegateResponse("call-1", "started", {
            subagent_session_id: "20260807_119",
          }),
        ],
      ]);
      expect(resolveDelegateContextForTask(messages, "20260807_119")).toEqual({
        subagentAgentName: "Trace",
        subagentTaskIsConfigured: true,
      });
      expect(
        resolveDelegateContextForTask(messages, "20260807_11"),
      ).toBeUndefined();
    });

    it("does not match a task id that prefixes another", () => {
      const messages = transcript([
        [
          delegateRequest("call-1", { source: "Rivet", async: true }),
          delegateResponse(
            "call-1",
            'Task 20260807_72 started in background: "count files"',
          ),
        ],
      ]);
      expect(
        resolveDelegateContextForTask(messages, "20260807_7"),
      ).toBeUndefined();
      expect(resolveDelegateContextForTask(messages, "20260807_72")).toEqual({
        subagentAgentName: "Rivet",
        subagentTaskIsConfigured: true,
      });
    });

    it("retains task-only provenance for ad-hoc delegates", () => {
      const messages = transcript([
        [
          delegateRequest("call-1", { instructions: "do a thing" }),
          delegateResponse(
            "call-1",
            'Task 20260807_119 started in background: "do a thing"',
          ),
        ],
      ]);
      expect(resolveDelegateContextForTask(messages, "20260807_119")).toEqual({
        subagentTaskLabel: "do a thing",
      });
    });

    it("returns undefined when no delegate mentions the task id", () => {
      expect(resolveDelegateContextForTask([], "20260807_119")).toBeUndefined();
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

  describe("codex collaboration", () => {
    it("preserves Codex agent identity and delegated task", () => {
      expect(
        getSubagentToolCallInfo({
          toolName: "spawn_agent",
          arguments: {
            task_name: "Rivet",
            message: "Investigate the failing tests",
          },
        }),
      ).toEqual({
        activity: "delegating",
        agentName: "Rivet",
        label: "Investigate the failing tests",
      });
    });

    it("falls back to the legacy prompt label", () => {
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

    it("prefers the Codex message when both task fields are present", () => {
      expect(
        getSubagentToolCallInfo({
          toolName: "spawn_agent",
          arguments: {
            message: "Use the collaboration task",
            prompt: "Legacy fallback",
          },
        }),
      ).toEqual({
        activity: "delegating",
        label: "Use the collaboration task",
      });
    });

    it("classifies spawn_agent when its provenance is unknown", () => {
      expect(
        getSubagentToolCallInfo({
          toolName: "spawn_agent",
          arguments: {},
        }),
      ).toEqual({ activity: "delegating" });
    });

    it.each([
      ["send_input", "agent-42", "Review the patch", "delegating"],
      ["send_message", "/root/reviewer", "Review the patch", "messaging"],
      ["followup_task", "/root/reviewer", "Review the patch", "delegating"],
    ])("preserves target and task for %s", (toolName, target, message, activity) => {
      expect(
        getSubagentToolCallInfo({
          toolName,
          arguments: { target, message },
        }),
      ).toEqual({
        activity,
        agentName: target,
        label: message,
      });
    });

    it.each([
      ["resume_agent", { id: "agent-42" }, "agent-42"],
      ["close_agent", { target: "agent-42" }, "agent-42"],
      ["interrupt_agent", { target: "/root/reviewer" }, "/root/reviewer"],
    ])("attributes %s to its target", (toolName, args, agentName) => {
      expect(getSubagentToolCallInfo({ toolName, arguments: args })).toEqual({
        activity:
          toolName === "resume_agent"
            ? "delegating"
            : toolName === "interrupt_agent"
              ? "interrupting"
              : "cancelling",
        agentName,
      });
    });

    it.each([
      ["spawn_agent", "Rivet", "Investigate the failing tests", "delegating"],
      ["send_input", "agent-42", "Review the patch", "delegating"],
      ["send_message", "/root/reviewer", "Review the patch", "messaging"],
      ["followup_task", "/root/reviewer", "Review the patch", "delegating"],
      ["resume_agent", "agent-42", undefined, "delegating"],
      ["wait_agent", "agent-42", undefined, "waiting"],
      ["close_agent", "agent-42", undefined, "cancelling"],
      ["interrupt_agent", "/root/reviewer", undefined, "interrupting"],
    ])("preserves codex-acp wire provenance for %s", (toolName, receiver, prompt, activity) => {
      expect(
        getSubagentToolCallInfo({
          toolName,
          arguments: {
            prompt,
            senderThreadId: "root",
            receiverThreadIds: [receiver],
            agentsStates: {},
            model: "gpt-5",
            reasoningEffort: "medium",
            status: "running",
          },
        }),
      ).toEqual({
        activity,
        agentName: receiver,
        ...(prompt ? { label: prompt } : {}),
      });
    });

    it("attributes a legacy wait with one target", () => {
      expect(
        getSubagentToolCallInfo({
          toolName: "wait_agent",
          arguments: { targets: ["agent-42"] },
        }),
      ).toEqual({ activity: "waiting", agentName: "agent-42" });
    });

    it("preserves every known target for multi-agent waits", () => {
      expect(
        getSubagentToolCallInfo({
          toolName: "wait_agent",
          arguments: { targets: ["agent-1", "agent-2"] },
        }),
      ).toEqual({
        activity: "waiting",
        agentNames: ["agent-1", "agent-2"],
      });
    });

    it.each([
      ["wait_agent", {}],
      ["wait_agent", { targets: ["agent-1", 42] }],
      ["wait_agent", { targets: ["agent-1", "   "] }],
      ["wait_agent", { targets: [42] }],
      ["wait_agent", { targets: ["   "] }],
      ["followup_task", { target: 42, message: [] }],
    ])("does not fabricate provenance for malformed or ambiguous %s", (toolName, args) => {
      expect(getSubagentToolCallInfo({ toolName, arguments: args })).toEqual({
        activity: toolName === "wait_agent" ? "waiting" : "delegating",
      });
    });
  });
});
