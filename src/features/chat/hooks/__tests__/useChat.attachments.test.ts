import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useChatStore } from "../../stores/chatStore";
import { useChatSessionStore } from "../../stores/chatSessionStore";

const mockAcpSendMessage = vi.fn();
const mockAcpCancelSession = vi.fn();
const mockAcpPrepareSession = vi.fn();

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
  acpPrepareSession: (...args: unknown[]) => mockAcpPrepareSession(...args),
}));

import { MAX_PROMPT_ATTACHMENT_BYTES } from "../../lib/attachmentPayloadBudget";
import { useChat } from "../useChat";

describe("useChat attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      personas: [],
      personasLoading: false,
      agents: [],
      agentsLoading: false,
      activeAgentId: null,
      isLoading: false,
    });
    mockAcpCancelSession.mockResolvedValue(true);
    mockAcpPrepareSession.mockResolvedValue(undefined);
  });

  it("stores non-image attachments in metadata and appends absolute paths to the prompt", async () => {
    const { result } = renderHook(() => useChat("session-1"));
    const attachments = [
      {
        id: "file-1",
        kind: "file" as const,
        name: "report.pdf",
        path: "/tmp/report.pdf",
        mimeType: "application/pdf",
      },
      {
        id: "dir-1",
        kind: "directory" as const,
        name: "screenshots",
        path: "/tmp/screenshots",
      },
    ];

    await act(async () => {
      await result.current.sendMessage(
        "Please review these",
        undefined,
        attachments,
      );
    });

    const message = useChatStore.getState().messagesBySession["session-1"][0];

    expect(message.metadata?.attachments).toEqual([
      {
        type: "file",
        name: "report.pdf",
        path: "/tmp/report.pdf",
        mimeType: "application/pdf",
      },
      {
        type: "directory",
        name: "screenshots",
        path: "/tmp/screenshots",
      },
    ]);
    expect(mockAcpSendMessage).toHaveBeenCalledWith(
      "session-1",
      "Please review these /tmp/report.pdf /tmp/screenshots",
      {
        systemPrompt: undefined,
        goose: undefined,
        onPromptDispatching: expect.any(Function),
        onPromptDispatched: expect.any(Function),
        personaId: undefined,
        personaName: undefined,
        images: undefined,
      },
    );

    // The bubble's displayed text must remain the raw user input — appended
    // paths are wire-only so they don't clutter the rendered message.
    expect(message.content).toEqual([
      { type: "text", text: "Please review these" },
    ]);
  });

  it("keeps local image attachments in ACP images while also passing their paths", async () => {
    const { result } = renderHook(() => useChat("session-1"));
    const attachments = [
      {
        id: "image-1",
        kind: "image" as const,
        name: "diagram.png",
        path: "/tmp/diagram.png",
        mimeType: "image/png",
        base64: "abc123",
        previewUrl: "tauri://localhost/tmp/diagram.png",
      },
    ];

    await act(async () => {
      await result.current.sendMessage("", undefined, attachments);
    });

    const message = useChatStore.getState().messagesBySession["session-1"][0];

    expect(message.metadata?.attachments).toEqual([
      {
        type: "file",
        name: "diagram.png",
        path: "/tmp/diagram.png",
        mimeType: "image/png",
      },
    ]);
    expect(message.content).toEqual([
      { type: "text", text: "" },
      {
        type: "image",
        data: "abc123",
        mimeType: "image/png",
      },
    ]);
    expect(mockAcpSendMessage).toHaveBeenCalledWith(
      "session-1",
      "/tmp/diagram.png",
      {
        systemPrompt: undefined,
        goose: undefined,
        onPromptDispatching: expect.any(Function),
        onPromptDispatched: expect.any(Function),
        personaId: undefined,
        personaName: undefined,
        images: [["abc123", "image/png"]],
      },
    );
  });

  it("keeps pathless pasted images working as ACP image content blocks", async () => {
    const { result } = renderHook(() => useChat("session-1"));
    const attachments = [
      {
        id: "image-1",
        kind: "image" as const,
        name: "pasted.png",
        mimeType: "image/png",
        base64: "abc123",
        previewUrl: "blob:pasted",
      },
    ];

    await act(async () => {
      await result.current.sendMessage("", undefined, attachments);
    });

    expect(mockAcpSendMessage).toHaveBeenCalledWith("session-1", " ", {
      systemPrompt: undefined,
      goose: undefined,
      onPromptDispatching: expect.any(Function),
      onPromptDispatched: expect.any(Function),
      personaId: undefined,
      personaName: undefined,
      images: [["abc123", "image/png"]],
    });
  });

  it("includes all available attachment paths in the prompt for mixed sends while images still flow through ACP image blocks", async () => {
    const { result } = renderHook(() => useChat("session-1"));
    const attachments = [
      {
        id: "file-1",
        kind: "file" as const,
        name: "mobile-confirmation.html",
        path: "/tmp/mobile-confirmation.html",
        mimeType: "text/html",
      },
      {
        id: "dir-1",
        kind: "directory" as const,
        name: "neighborhood block",
        path: "/tmp/neighborhood block",
      },
      {
        id: "image-1",
        kind: "image" as const,
        name: "Screenshot 2026-04-09 at 1.25.32 PM.png",
        path: "/tmp/Screenshot.png",
        mimeType: "image/png",
        base64: "abc123",
        previewUrl: "tauri://localhost/tmp/Screenshot.png",
      },
    ];

    await act(async () => {
      await result.current.sendMessage(
        "can you see the attachments i attached?",
        undefined,
        attachments,
      );
    });

    expect(mockAcpSendMessage).toHaveBeenCalledWith(
      "session-1",
      "can you see the attachments i attached? /tmp/mobile-confirmation.html /tmp/neighborhood block /tmp/Screenshot.png",
      {
        systemPrompt: undefined,
        goose: undefined,
        onPromptDispatching: expect.any(Function),
        onPromptDispatched: expect.any(Function),
        personaId: undefined,
        personaName: undefined,
        images: [["abc123", "image/png"]],
      },
    );
  });

  it("preserves pathless browser file attachments in sent message metadata", async () => {
    const { result } = renderHook(() => useChat("session-1"));
    const attachments = [
      {
        id: "file-1",
        kind: "file" as const,
        name: "report.pdf",
        mimeType: "application/pdf",
      },
    ];

    await act(async () => {
      await result.current.sendMessage(
        "Please review this",
        undefined,
        attachments,
      );
    });

    const message = useChatStore.getState().messagesBySession["session-1"][0];

    expect(message.metadata?.attachments).toEqual([
      {
        type: "file",
        name: "report.pdf",
        mimeType: "application/pdf",
      },
    ]);
    expect(mockAcpSendMessage).toHaveBeenCalledWith(
      "session-1",
      "Please review this",
      {
        systemPrompt: undefined,
        goose: undefined,
        onPromptDispatching: expect.any(Function),
        onPromptDispatched: expect.any(Function),
        personaId: undefined,
        personaName: undefined,
        images: undefined,
      },
    );
  });

  it("rejects an over-budget attachment payload before committing anything", async () => {
    // Discriminating test for the dispatchPrompt budget guard: this is the
    // only budget check on non-composer paths (berdctl, queue flush), where
    // an oversized ACP message would silently kill the shared WebSocket and
    // every open chat with it (BOT-1463). Pre-guard code sends the payload
    // and commits the user message; guarded code must do neither.
    const { result } = renderHook(() => useChat("session-1"));
    const attachments = [
      {
        id: "image-1",
        kind: "image" as const,
        name: "huge.jpeg",
        mimeType: "image/jpeg",
        base64: "x".repeat(MAX_PROMPT_ATTACHMENT_BYTES + 1),
        previewUrl: "blob:huge",
      },
    ];

    await act(async () => {
      await result.current.sendMessage("look at this", undefined, attachments);
    });

    // Nothing goes over the wire and no user message lands in the
    // transcript — the draft stays with the composer for the user to fix.
    expect(mockAcpSendMessage).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().messagesBySession["session-1"] ?? [],
    ).toHaveLength(0);

    // The failure is recorded, not silent: session error state carries the
    // user-facing budget message.
    expect(
      useChatStore.getState().getSessionRuntime("session-1").error,
    ).toBeTruthy();
  });
});
