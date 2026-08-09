import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useChatStore } from "../../stores/chatStore";
import { useChatSessionStore } from "../../stores/chatSessionStore";
import { clearReplayBuffer } from "../replayBuffer";

const mockAcpSendMessage = vi.fn();
const mockAcpCancelSession = vi.fn();
const mockAcpLoadSession = vi.fn();

vi.mock("@/shared/api/acp", () => ({
  acpSendMessage: (...args: unknown[]) => {
    const result = mockAcpSendMessage(...args);
    const options = args[2] as
      | {
          onPromptDispatching?: () => void;
          onPromptDispatched?: () => void;
        }
      | undefined;
    options?.onPromptDispatching?.();
    options?.onPromptDispatched?.();
    return result;
  },
  acpCancelSession: (...args: unknown[]) => mockAcpCancelSession(...args),
  acpLoadSession: (...args: unknown[]) => mockAcpLoadSession(...args),
}));

import { useChat } from "../useChat";

describe("useChat persona preparation", () => {
  beforeEach(() => {
    mockAcpSendMessage.mockReset();
    mockAcpCancelSession.mockReset();
    mockAcpLoadSession.mockReset();
    clearReplayBuffer("session-1");
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      activeSessionId: null,
      isConnected: true,
    });
    useChatSessionStore.setState({
      sessions: [],
      activeSessionId: null,
      isLoading: false,
      isRightRailOpen: false,
      activeWorkspaceBySession: {},
    });
    useAgentStore.setState({
      personas: [
        {
          id: "persona-a",
          displayName: "Persona A",
          systemPrompt: "",
          isBuiltin: false,
          writable: true,
          createdAt: "",
          updatedAt: "",
        },
        {
          id: "persona-b",
          displayName: "Persona B",
          systemPrompt: "",
          isBuiltin: false,
          writable: true,
          createdAt: "",
          updatedAt: "",
        },
      ],
      personasLoading: false,
      agents: [],
      agentsLoading: false,
      activeAgentId: null,
      isLoading: false,
    });
    mockAcpSendMessage.mockResolvedValue(undefined);
    mockAcpCancelSession.mockResolvedValue(true);
    mockAcpLoadSession.mockResolvedValue(undefined);
  });

  it("passes a queued session selection through preparation", async () => {
    const ensurePrepared = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useChat(
        "session-1",
        undefined,
        undefined,
        { id: "persona-a", name: "Persona A" },
        { ensurePrepared },
      ),
    );

    await act(async () => {
      await result.current.sendMessage(
        "Hello",
        { id: "persona-a" },
        undefined,
        {
          sessionSelection: {
            harnessId: "goose",
            modelProviderId: "databricks_v2",
            modelId: "goose-gpt-5-6-sol",
            modelName: "goose-gpt-5-6-sol",
          },
        },
      );
    });

    expect(ensurePrepared).toHaveBeenCalledWith(
      "persona-a",
      {
        harnessId: "goose",
        modelProviderId: "databricks_v2",
        modelId: "goose-gpt-5-6-sol",
        modelName: "goose-gpt-5-6-sol",
      },
      undefined,
    );
  });

  it("prepares the override persona before prompting", async () => {
    const ensurePrepared = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useChat(
        "session-1",
        undefined,
        undefined,
        { id: "persona-a", name: "Persona A" },
        { ensurePrepared },
      ),
    );

    await act(async () => {
      await result.current.sendMessage("Hello", { id: "persona-b" });
    });

    expect(ensurePrepared).toHaveBeenCalledWith("persona-b");
    expect(mockAcpSendMessage).toHaveBeenCalledWith("session-1", "Hello", {
      systemPrompt: undefined,
      goose: undefined,
      onPromptDispatching: expect.any(Function),
      onPromptDispatched: expect.any(Function),
      personaId: "persona-b",
      personaName: "Persona B",
      images: undefined,
    });
  });
});
