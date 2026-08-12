import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChangeSessionFolder } from "./useChangeSessionFolder";

const {
  mockOpenDialog,
  mockEnsureDirectory,
  mockUpdateWorkingDir,
  mockSupersedePendingActivation,
  mockReleaseWorkspaceSend,
  mockToastSuccess,
  mockToastError,
} = vi.hoisted(() => ({
  mockOpenDialog: vi.fn(),
  mockEnsureDirectory: vi.fn(),
  mockUpdateWorkingDir: vi.fn(),
  mockSupersedePendingActivation: vi.fn(),
  mockReleaseWorkspaceSend: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mockOpenDialog,
}));

vi.mock("@/shared/api/system", () => ({
  ensureDirectory: mockEnsureDirectory,
}));

vi.mock("@/shared/api/acpApi", () => ({
  updateWorkingDir: mockUpdateWorkingDir,
}));

vi.mock("@/features/chat/lib/sessionWorkspaceActivation", () => ({
  supersedePendingSessionWorkspaceActivation: mockSupersedePendingActivation,
}));

vi.mock("@/features/chat/lib/firstWorkspaceSend", () => ({
  releaseWorkspaceSendAfterUserEdit: mockReleaseWorkspaceSend,
}));

vi.mock("sonner", () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
  },
}));

const SESSION_ID = "session-1";
const WARNING_NOTICE_ID = `session-load-warning:${SESSION_ID}`;

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function seedSession() {
  useChatSessionStore.setState({
    sessions: [
      {
        id: SESSION_ID,
        title: "Chat",
        workingDir: "/old/folder",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 1,
      },
    ],
    activeWorkspaceBySession: {},
  });
}

function seedMissingFolderNotice() {
  useChatStore.getState().addMessage(SESSION_ID, {
    id: WARNING_NOTICE_ID,
    role: "system",
    created: Date.now(),
    content: [
      {
        type: "systemNotification",
        notificationType: "warning",
        text: "This session's folder no longer exists",
        action: { type: "openContextPanel" },
      },
    ],
  });
}

function sessionMessages() {
  return useChatStore.getState().messagesBySession[SESSION_ID] ?? [];
}

describe("useChangeSessionFolder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureDirectory.mockResolvedValue(undefined);
    mockUpdateWorkingDir.mockResolvedValue(undefined);
    mockSupersedePendingActivation.mockResolvedValue(undefined);
    useChatStore.setState({ messagesBySession: {} });
    seedSession();
  });

  it("re-points the session and clears the missing-folder notice", async () => {
    seedMissingFolderNotice();
    mockOpenDialog.mockResolvedValue("/new/folder");

    const { result } = renderHook(
      () => useChangeSessionFolder(SESSION_ID, { defaultPath: "/old/folder" }),
      { wrapper },
    );

    await act(async () => {
      await result.current.changeFolder();
    });

    expect(mockEnsureDirectory).toHaveBeenCalledWith("/new/folder");
    expect(mockSupersedePendingActivation).toHaveBeenCalledWith(SESSION_ID);
    expect(mockUpdateWorkingDir).toHaveBeenCalledWith(
      SESSION_ID,
      "/new/folder",
    );
    expect(mockReleaseWorkspaceSend).toHaveBeenCalledWith(SESSION_ID);
    expect(mockToastSuccess).toHaveBeenCalled();

    const session = useChatSessionStore
      .getState()
      .sessions.find((candidate) => candidate.id === SESSION_ID);
    expect(session?.workingDir).toBe("/new/folder");
    expect(
      useChatSessionStore.getState().activeWorkspaceBySession[SESSION_ID],
    ).toEqual({ path: "/new/folder", branch: null });

    await waitFor(() => {
      expect(
        sessionMessages().some((message) => message.id === WARNING_NOTICE_ID),
      ).toBe(false);
    });
  });

  it("ignores re-entrant calls while the picker is already open", async () => {
    let resolvePicker!: (value: string) => void;
    mockOpenDialog.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvePicker = resolve;
        }),
    );

    const { result } = renderHook(() => useChangeSessionFolder(SESSION_ID), {
      wrapper,
    });

    let firstCall!: Promise<void>;
    let secondCall!: Promise<void>;
    await act(async () => {
      // A double-click fires two invocations before the first resolves; the
      // second must be swallowed instead of stacking a second picker.
      firstCall = result.current.changeFolder();
      secondCall = result.current.changeFolder();
      await secondCall;
      // The picker opens behind a dynamic import; wait for it before
      // resolving the user's selection.
      await waitFor(() => expect(mockOpenDialog).toHaveBeenCalled());
      resolvePicker("/new/folder");
      await firstCall;
    });

    expect(mockOpenDialog).toHaveBeenCalledTimes(1);
    expect(mockUpdateWorkingDir).toHaveBeenCalledTimes(1);
    expect(mockToastSuccess).toHaveBeenCalledTimes(1);
  });

  it("attaches the picked folder as a workspace when requested", async () => {
    mockOpenDialog.mockResolvedValue("/new/folder");

    const { result } = renderHook(
      () => useChangeSessionFolder(SESSION_ID, { attachWorkspace: true }),
      { wrapper },
    );

    await act(async () => {
      await result.current.changeFolder();
    });

    const session = useChatSessionStore
      .getState()
      .sessions.find((candidate) => candidate.id === SESSION_ID);
    expect(
      session?.workspaceAttachments?.some(
        (attachment) => attachment.path === "/new/folder",
      ),
    ).toBe(true);
  });

  it("keeps the notice and session state when the picker is cancelled", async () => {
    seedMissingFolderNotice();
    mockOpenDialog.mockResolvedValue(null);

    const { result } = renderHook(() => useChangeSessionFolder(SESSION_ID), {
      wrapper,
    });

    await act(async () => {
      await result.current.changeFolder();
    });

    expect(mockUpdateWorkingDir).not.toHaveBeenCalled();
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
    expect(
      sessionMessages().some((message) => message.id === WARNING_NOTICE_ID),
    ).toBe(true);
    const session = useChatSessionStore
      .getState()
      .sessions.find((candidate) => candidate.id === SESSION_ID);
    expect(session?.workingDir).toBe("/old/folder");
  });

  it("surfaces an error toast and keeps the notice when the update fails", async () => {
    seedMissingFolderNotice();
    mockOpenDialog.mockResolvedValue("/new/folder");
    mockUpdateWorkingDir.mockRejectedValue(new Error("update failed"));

    const { result } = renderHook(() => useChangeSessionFolder(SESSION_ID), {
      wrapper,
    });

    await act(async () => {
      await result.current.changeFolder();
    });

    expect(mockToastError).toHaveBeenCalled();
    expect(
      sessionMessages().some((message) => message.id === WARNING_NOTICE_ID),
    ).toBe(true);
  });
});
