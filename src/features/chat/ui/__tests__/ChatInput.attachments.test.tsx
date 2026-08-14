import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatInput } from "./chatInputTestUtils";

vi.mock("@/features/chat/hooks/useVoiceDictation", () => ({
  useAnyVoiceDictationActive: () => false,
  useVoiceDictation: () => ({
    isEnabled: false,
    isRecording: false,
    isTranscribing: false,
    isStarting: () => false,
    stopRecording: vi.fn(),
    toggleRecording: vi.fn(),
  }),
}));

vi.mock("@/features/chat/hooks/useMentionHandlers", () => ({
  useMentionHandlers: () => ({
    mentionOpen: false,
    atMentionCategory: "agents",
    mentionSelectedIndex: 0,
    filteredPersonas: [],
    filteredSkills: [],
    filteredFiles: [],
    fileMentionsLoading: false,
    fileMentionsError: null,
    skillMentionItems: [],
    detectMention: vi.fn(),
    closeMention: vi.fn(),
    navigateMention: vi.fn(),
    setAtMentionCategory: vi.fn(),
    handleMentionCategoryKey: vi.fn(),
    confirmMention: vi.fn(),
    handleMentionConfirm: vi.fn(),
    resolveSkillSlashCommand: vi.fn(),
    handlePersonaMentionSelect: vi.fn(),
    handleSkillMentionSelect: vi.fn(),
    handleFileMentionSelect: vi.fn(),
  }),
}));

vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => ({
    readyAgentIds: new Set(["goose", "claude-acp", "codex-acp"]),
    agentReadiness: new Map([
      ["goose", "ready"],
      ["claude-acp", "ready"],
      ["codex-acp", "ready"],
    ]),
    loading: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/shared/lib/platform", () => ({
  getPlatform: () => "mac",
}));

const mockSearchFilesForMentions = vi.fn<
  (input: {
    roots: string[];
    query: string;
    maxResults?: number;
  }) => Promise<unknown[]>
>(async () => []);
const mockInspectAttachmentPaths = vi.fn<
  (paths: string[]) => Promise<
    {
      name: string;
      path: string;
      kind: "file" | "directory";
      mimeType?: string | null;
    }[]
  >
>(async () => []);
const mockReadImageAttachment = vi.fn<
  (path: string) => Promise<{ base64: string; mimeType: string }>
>(async () => ({ base64: "abc", mimeType: "image/png" }));

vi.mock("@/shared/api/system", () => ({
  getHomeDir: vi.fn().mockResolvedValue("/Users/wesb"),
  searchFilesForMentions: (input: {
    roots: string[];
    query: string;
    maxResults?: number;
  }) => mockSearchFilesForMentions(input),
  inspectAttachmentPaths: (paths: string[]) =>
    mockInspectAttachmentPaths(paths),
  readImageAttachment: (path: string) => mockReadImageAttachment(path),
}));

const mockResizeImage = vi.fn((file: File) =>
  Promise.resolve({ base64: `base64:${file.name}`, mimeType: file.type }),
);

// jsdom cannot decode image bytes, so stand in for the normalize pipeline;
// its behavior is covered by useChatInputAttachments tests.
vi.mock("@/features/chat/lib/resizeImage", () => ({
  resizeImage: (file: File) => mockResizeImage(file),
  normalizeImageBase64: (base64: string, mimeType: string | undefined) =>
    Promise.resolve({ base64, mimeType }),
}));

vi.mock("@/features/skills/api/skills", () => ({
  listSkills: vi.fn().mockResolvedValue([]),
}));

const mockOpenDialog = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => mockOpenDialog(...args),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));

describe("ChatInput attachments", () => {
  beforeEach(() => {
    mockResizeImage.mockReset();
    mockResizeImage.mockImplementation((file) =>
      Promise.resolve({ base64: `base64:${file.name}`, mimeType: file.type }),
    );
    mockSearchFilesForMentions.mockClear();
    mockSearchFilesForMentions.mockResolvedValue([]);
    mockInspectAttachmentPaths.mockClear();
    mockInspectAttachmentPaths.mockResolvedValue([]);
    mockReadImageAttachment.mockClear();
    mockReadImageAttachment.mockResolvedValue({
      base64: "abc",
      mimeType: "image/png",
    });
    mockOpenDialog.mockClear();
    mockOpenDialog.mockResolvedValue(null);
  });

  it("attaches a file from the toolbar menu and sends it without text", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    mockOpenDialog.mockResolvedValue("/Users/test/report.pdf");
    mockInspectAttachmentPaths.mockResolvedValue([
      {
        name: "report.pdf",
        path: "/Users/test/report.pdf",
        kind: "file",
        mimeType: "application/pdf",
      },
    ]);

    render(<ChatInput onSend={onSend} />);

    await user.click(screen.getByRole("button", { name: /attach/i }));
    await user.click(screen.getByRole("menuitem", { name: /^file$/i }));

    expect(mockOpenDialog).toHaveBeenCalledWith({
      title: "Choose files to attach",
      multiple: true,
    });
    expect(await screen.findByText("report.pdf")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(onSend).toHaveBeenCalledWith(
      "",
      null,
      expect.arrayContaining([
        expect.objectContaining({
          kind: "file",
          name: "report.pdf",
          path: "/Users/test/report.pdf",
        }),
      ]),
    );
  });

  it("attaches a folder from the toolbar menu", async () => {
    const user = userEvent.setup();
    mockOpenDialog.mockResolvedValue("/Users/test/screenshots");
    mockInspectAttachmentPaths.mockResolvedValue([
      {
        name: "screenshots",
        path: "/Users/test/screenshots",
        kind: "directory",
      },
    ]);

    render(<ChatInput onSend={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /attach/i }));
    await user.click(screen.getByRole("menuitem", { name: /folder/i }));

    expect(mockOpenDialog).toHaveBeenCalledWith({
      directory: true,
      title: "Choose folders to attach",
      multiple: true,
    });
    expect(await screen.findByText("screenshots")).toBeInTheDocument();
  });

  it("shows the generic attachment drop overlay for file drags", () => {
    render(<ChatInput onSend={vi.fn()} />);

    const textbox = screen.getByRole("textbox");
    const composer = textbox.closest("div.rounded-composer");
    if (!composer) {
      throw new Error("Expected composer container");
    }
    const dataTransfer = {
      files: [new File(["hello"], "report.txt", { type: "text/plain" })],
      items: [{ kind: "file" }],
      types: ["Files"],
    } as unknown as DataTransfer;

    fireEvent.dragEnter(composer, { dataTransfer });
    fireEvent.dragOver(composer, { dataTransfer });

    expect(screen.getByText("Drop files or folders")).toBeInTheDocument();
  });

  it("accepts dropped attachments while streaming", async () => {
    render(<ChatInput onSend={vi.fn()} isStreaming />);

    const textbox = screen.getByRole("textbox");
    const composer = textbox.closest("div.rounded-composer");
    if (!composer) {
      throw new Error("Expected composer container");
    }
    const file = new File(["hello"], "report.txt", { type: "text/plain" });
    const dataTransfer = {
      files: [file],
      items: [{ kind: "file" }],
      types: ["Files"],
    } as unknown as DataTransfer;

    fireEvent.dragEnter(composer, { dataTransfer });
    fireEvent.dragOver(composer, { dataTransfer });

    expect(screen.getByText("Drop files or folders")).toBeInTheDocument();

    fireEvent.drop(composer, { dataTransfer });

    await waitFor(() => {
      expect(
        screen.queryByText("Drop files or folders"),
      ).not.toBeInTheDocument();
    });
    expect(await screen.findByText("report.txt")).toBeInTheDocument();
  });

  it("does not steer a queued message while attachment work is pending", async () => {
    const onSend = vi.fn();
    const onSteerQueuedMessage = vi.fn();
    const user = userEvent.setup();
    let releaseResize: (() => void) | undefined;
    mockResizeImage.mockImplementationOnce(
      (file) =>
        new Promise((resolve) => {
          releaseResize = () =>
            resolve({ base64: `base64:${file.name}`, mimeType: file.type });
        }),
    );
    render(
      <ChatInput
        onSend={onSend}
        onSteerQueuedMessage={onSteerQueuedMessage}
        canSteerQueuedMessage
        isStreaming
        queuedMessage={{ persona: { kind: "none" }, text: "queued msg" }}
      />,
    );

    const textbox = screen.getByRole("textbox");
    const composer = textbox.closest("div.rounded-composer");
    if (!composer) {
      throw new Error("Expected composer container");
    }
    const dataTransfer = {
      files: [new File(["img"], "shot.png", { type: "image/png" })],
      items: [{ kind: "file" }],
      types: ["Files"],
    } as unknown as DataTransfer;
    fireEvent.drop(composer, { dataTransfer });

    await user.keyboard("{Enter}");

    expect(onSteerQueuedMessage).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();

    releaseResize?.();
    expect(
      await screen.findByRole("button", { name: "View attachment 1" }),
    ).toBeInTheDocument();
  });

  it("does not cancel non-file drops into the composer", () => {
    render(<ChatInput onSend={vi.fn()} />);

    const textbox = screen.getByRole("textbox");
    const composer = textbox.closest("div.rounded-composer");
    if (!composer) {
      throw new Error("Expected composer container");
    }

    const dropEvent = createEvent.drop(composer, {
      dataTransfer: {
        files: [],
        items: [{ kind: "string" }],
        types: ["text/plain"],
      },
    });
    dropEvent.preventDefault = vi.fn();

    fireEvent(composer, dropEvent);

    expect(dropEvent.preventDefault).not.toHaveBeenCalled();
  });

  it("opens image attachments in a keyboard-navigable lightbox", async () => {
    const user = userEvent.setup();
    mockOpenDialog.mockResolvedValue([
      "/Users/test/one.png",
      "/Users/test/two.png",
    ]);
    mockInspectAttachmentPaths.mockResolvedValue([
      {
        name: "one.png",
        path: "/Users/test/one.png",
        kind: "file",
        mimeType: "image/png",
      },
      {
        name: "two.png",
        path: "/Users/test/two.png",
        kind: "file",
        mimeType: "image/png",
      },
    ]);
    mockReadImageAttachment
      .mockResolvedValueOnce({ base64: "one", mimeType: "image/png" })
      .mockResolvedValueOnce({ base64: "two", mimeType: "image/png" });

    render(<ChatInput onSend={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /attach/i }));
    await user.click(screen.getByRole("menuitem", { name: /^file$/i }));

    await waitFor(() => {
      expect(screen.getByAltText("Attachment 2")).toBeInTheDocument();
    });

    await user.click(
      screen.getByRole("button", { name: /view attachment 1/i }),
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByAltText("Attachment 1")).toHaveAttribute(
      "src",
      "/Users/test/one.png",
    );

    await user.keyboard("{ArrowRight}");
    expect(within(dialog).getByAltText("Attachment 2")).toHaveAttribute(
      "src",
      "/Users/test/two.png",
    );

    await user.keyboard("{ArrowLeft}");
    expect(within(dialog).getByAltText("Attachment 1")).toHaveAttribute(
      "src",
      "/Users/test/one.png",
    );
  });

  it("renders mixed attachments from a single file picker pass", async () => {
    const user = userEvent.setup();
    mockOpenDialog.mockResolvedValue([
      "/Users/test/report.pdf",
      "/Users/test/diagram.png",
    ]);
    mockInspectAttachmentPaths.mockResolvedValue([
      {
        name: "report.pdf",
        path: "/Users/test/report.pdf",
        kind: "file",
        mimeType: "application/pdf",
      },
      {
        name: "diagram.png",
        path: "/Users/test/diagram.png",
        kind: "file",
        mimeType: "image/png",
      },
    ]);

    render(<ChatInput onSend={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /attach/i }));
    await user.click(screen.getByRole("menuitem", { name: /^file$/i }));

    expect(await screen.findByText("report.pdf")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByAltText("Attachment 2")).toBeInTheDocument();
    });
  });

  it("restores initial draft attachments and mirrors subsequent changes", async () => {
    const onDraftAttachmentsChange = vi.fn();
    const user = userEvent.setup();
    const initialAttachment = {
      id: "initial-report",
      kind: "file" as const,
      name: "initial-report.pdf",
      path: "/Users/test/initial-report.pdf",
      mimeType: "application/pdf",
    };
    mockOpenDialog.mockResolvedValue("/Users/test/next-report.pdf");
    mockInspectAttachmentPaths.mockResolvedValue([
      {
        name: "next-report.pdf",
        path: "/Users/test/next-report.pdf",
        kind: "file",
        mimeType: "application/pdf",
      },
    ]);

    render(
      <ChatInput
        onSend={vi.fn()}
        initialAttachments={[initialAttachment]}
        onDraftAttachmentsChange={onDraftAttachmentsChange}
      />,
    );

    expect(await screen.findByText("initial-report.pdf")).toBeInTheDocument();
    await waitFor(() => {
      expect(onDraftAttachmentsChange).toHaveBeenCalledWith([
        initialAttachment,
      ]);
    });

    await user.click(screen.getByRole("button", { name: /^attach$/i }));
    await user.click(screen.getByRole("menuitem", { name: /^file$/i }));

    await waitFor(() => {
      expect(onDraftAttachmentsChange).toHaveBeenCalledWith([
        initialAttachment,
        expect.objectContaining({
          kind: "file",
          name: "next-report.pdf",
          path: "/Users/test/next-report.pdf",
        }),
      ]);
    });
  });

  it("clears mirrored draft attachments after a successful send", async () => {
    const onDraftAttachmentsChange = vi.fn();
    const user = userEvent.setup();
    const initialAttachment = {
      id: "initial-report",
      kind: "file" as const,
      name: "initial-report.pdf",
      path: "/Users/test/initial-report.pdf",
      mimeType: "application/pdf",
    };

    render(
      <ChatInput
        onSend={vi.fn()}
        initialAttachments={[initialAttachment]}
        onDraftAttachmentsChange={onDraftAttachmentsChange}
      />,
    );

    expect(await screen.findByText("initial-report.pdf")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(onDraftAttachmentsChange).toHaveBeenLastCalledWith([]);
    });
  });

  it("dedupes path attachments that differ only by case on case-insensitive platforms", async () => {
    const user = userEvent.setup();
    mockOpenDialog.mockResolvedValue("/Users/test/report.pdf");
    mockInspectAttachmentPaths
      .mockResolvedValueOnce([
        {
          name: "report.pdf",
          path: "/Users/test/report.pdf",
          kind: "file",
          mimeType: "application/pdf",
        },
      ])
      .mockResolvedValueOnce([
        {
          name: "report.pdf",
          path: "/users/test/REPORT.pdf",
          kind: "file",
          mimeType: "application/pdf",
        },
      ]);

    render(<ChatInput onSend={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /^attach$/i }));
    await user.click(screen.getByRole("menuitem", { name: /^file$/i }));
    expect(await screen.findByText("report.pdf")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^attach$/i }));
    await user.click(screen.getByRole("menuitem", { name: /^file$/i }));

    expect(screen.getAllByText("report.pdf")).toHaveLength(1);
  });
});
