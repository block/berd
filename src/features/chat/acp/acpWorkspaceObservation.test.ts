import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { setMultiWorkspaceEnabled } from "@/features/workspaces/multiWorkspacePreference";
import {
  clearWorkspaceToolCallObservations,
  observeWorkspaceToolCall,
} from "./acpWorkspaceObservation";

const mocks = vi.hoisted(() => ({ attachSessionFolder: vi.fn() }));
vi.mock("@/features/chat/lib/sessionFolderRegistration", () => ({
  attachSessionFolder: (...args: unknown[]) =>
    mocks.attachSessionFolder(...args),
}));

const started = (rawInput: unknown): SessionUpdate =>
  ({
    sessionUpdate: "tool_call",
    toolCallId: "tool-1",
    title: "shell",
    kind: "execute",
    rawInput,
  }) as SessionUpdate;
const finished = (status: "completed" | "failed"): SessionUpdate =>
  ({
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-1",
    status,
  }) as SessionUpdate;

describe("ACP workspace observation", () => {
  beforeEach(() => {
    setMultiWorkspaceEnabled(true);
    mocks.attachSessionFolder.mockReset().mockResolvedValue({});
    clearWorkspaceToolCallObservations("session-1");
  });

  it("registers a structured cwd only after the tool succeeds", async () => {
    observeWorkspaceToolCall(
      "session-1",
      started({ command: "test", cwd: "/worktree" }),
    );
    expect(mocks.attachSessionFolder).not.toHaveBeenCalled();

    observeWorkspaceToolCall("session-1", finished("completed"));
    await vi.waitFor(() =>
      expect(mocks.attachSessionFolder).toHaveBeenCalledWith(
        "session-1",
        "/worktree",
      ),
    );
  });

  it("registers a cwd supplied by a single completed tool update", async () => {
    observeWorkspaceToolCall("session-1", {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      kind: "execute",
      rawInput: { cwd: "/one-shot" },
    } as SessionUpdate);

    await vi.waitFor(() =>
      expect(mocks.attachSessionFolder).toHaveBeenCalledWith(
        "session-1",
        "/one-shot",
      ),
    );
  });

  it("prefers a created output path over the execution parent cwd", async () => {
    observeWorkspaceToolCall(
      "session-1",
      started({ command: "create", cwd: "/parent" }),
    );
    observeWorkspaceToolCall("session-1", {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      title: "create worktree",
      status: "completed",
      rawOutput: { path: "/created-worktree" },
    } as SessionUpdate);

    await vi.waitFor(() =>
      expect(mocks.attachSessionFolder).toHaveBeenCalledWith(
        "session-1",
        "/created-worktree",
      ),
    );
  });

  it("registers explicit structured path evidence from a completed result", async () => {
    observeWorkspaceToolCall("session-1", started({ command: "create" }));
    observeWorkspaceToolCall("session-1", {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      title: "create worktree",
      status: "completed",
      rawOutput: { path: "/result-worktree" },
    } as SessionUpdate);

    await vi.waitFor(() =>
      expect(mocks.attachSessionFolder).toHaveBeenCalledWith(
        "session-1",
        "/result-worktree",
      ),
    );
  });

  it("does not guess paths from commands, generic input path args, prose results, or failures", async () => {
    observeWorkspaceToolCall(
      "session-1",
      started({ command: "git worktree add /sensitive", path: "/sensitive" }),
    );
    observeWorkspaceToolCall("session-1", finished("completed"));
    observeWorkspaceToolCall("session-1", {
      sessionUpdate: "tool_call",
      toolCallId: "prose-1",
      title: "shell",
      kind: "execute",
      status: "completed",
      rawOutput: "created /sensitive",
    } as SessionUpdate);
    observeWorkspaceToolCall("session-1", started({ cwd: "/failed" }));
    observeWorkspaceToolCall("session-1", finished("failed"));
    observeWorkspaceToolCall("session-1", {
      sessionUpdate: "tool_call",
      toolCallId: "read-1",
      title: "read",
      kind: "read",
      rawInput: { cwd: "/read-only" },
      status: "completed",
    } as SessionUpdate);
    await Promise.resolve();
    expect(mocks.attachSessionFolder).not.toHaveBeenCalled();
  });
  it("ignores all automatic observations when multi-workspace support is off", async () => {
    setMultiWorkspaceEnabled(false);
    observeWorkspaceToolCall("session-1", started({ cwd: "/disabled" }));
    observeWorkspaceToolCall("session-1", finished("completed"));
    await Promise.resolve();
    expect(mocks.attachSessionFolder).not.toHaveBeenCalled();
  });

  it("does not treat a generic successful output path as work intent", async () => {
    observeWorkspaceToolCall("session-1", started({ command: "inspect" }));
    observeWorkspaceToolCall("session-1", {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      title: "inspect directory",
      status: "completed",
      rawOutput: { path: "/inspected" },
    } as SessionUpdate);
    await Promise.resolve();
    expect(mocks.attachSessionFolder).not.toHaveBeenCalled();
  });
});
