import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { HomeScreen } from "./HomeScreen";

const setSelectedProvider = vi.fn();
const setSelectedProviderWithoutPersist = vi.fn();
const mockOpenDialog = vi.fn();
const mockInspectAttachmentPaths = vi.fn();
const mockReadImageAttachment = vi.fn();
const mockController = {
  handleSend: vi.fn(),
  projectMetadataPending: false,
  queue: {
    queuedMessage: null,
    queuedRecords: [] as Array<{
      kind: "deferred" | "transport-ready";
      recordId: string;
      payload: { text: string };
      state?: { status: string };
    }>,
    dismiss: vi.fn(),
    update: vi.fn(),
    beginEditing: vi.fn(),
    cancelEditing: vi.fn(),
  },
  deferredWorkspaceRecord: null as {
    payload: { text: string };
    state: { status: "naming" | "creating" };
  } | null,
  stopStreaming: vi.fn(),
  chatState: "idle" as const,
  personas: [
    {
      id: "builtin-solo",
      displayName: "Solo",
      systemPrompt: "You are Solo.",
      provider: "openai",
      description: null,
      avatar: null,
      createdBy: null,
      source: "custom",
      extensions: [],
      metadata: null,
      sortOrder: 0,
      isDefault: false,
    },
    {
      id: "builtin-goose",
      displayName: "Goosey",
      systemPrompt: "You are Goosey.",
      isBuiltin: true,
      writable: false,
      description: null,
      avatar: null,
      createdBy: null,
      source: "custom",
      extensions: [],
      metadata: null,
      sortOrder: 1,
      isDefault: false,
      createdAt: "",
      updatedAt: "",
    },
  ],
  draftValue: "",
  handleDraftChange: vi.fn(),
  selectedPersonaId: null,
  handlePersonaChange: vi.fn(),
  handleCreatePersona: vi.fn(),
  pickerAgents: [
    { id: "goose", label: "Goose" },
    { id: "claude-acp", label: "Claude Code" },
  ],
  providersLoading: false,
  selectedProvider: "goose",
  handleProviderChange: setSelectedProvider,
  currentModelId: null,
  currentModelProviderId: null,
  currentModelName: null,
  availableModels: [],
  modelsLoading: false,
  modelStatusMessage: null,
  handleModelChange: vi.fn(),
  selectedProjectId: null,
  availableProjects: [],
  handleProjectChange: vi.fn(),
  tokenState: { accumulatedTotal: 0, contextLimit: 0 },
  isContextUsageReady: false,
};

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
    skillMentionItems: [],
  }),
}));

vi.mock("@/shared/api/acp", () => ({
  discoverAcpProviders: vi.fn().mockResolvedValue([
    { id: "goose", label: "Goose" },
    { id: "claude-acp", label: "Claude Code" },
  ]),
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

vi.mock("@/features/skills/api/skills", () => ({
  listSkills: vi.fn().mockResolvedValue([]),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => mockOpenDialog(...args),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));

vi.mock("@/shared/api/system", () => ({
  inspectAttachmentPaths: (paths: string[]) =>
    mockInspectAttachmentPaths(paths),
  readImageAttachment: (path: string) => mockReadImageAttachment(path),
  getHomeDir: vi.fn().mockResolvedValue("/Users/wesb"),
  searchFilesForMentions: vi.fn().mockResolvedValue([]),
}));

// jsdom cannot decode image bytes, so stand in for the normalize pipeline;
// its behavior is covered by useChatInputAttachments tests.
vi.mock("@/features/chat/lib/resizeImage", () => ({
  resizeImage: (file: File) =>
    Promise.resolve({ base64: `base64:${file.name}`, mimeType: file.type }),
  normalizeImageBase64: (base64: string, mimeType: string | undefined) =>
    Promise.resolve({ base64, mimeType }),
}));

vi.mock("@/features/chat/hooks/useChatSessionController", () => ({
  useChatSessionController: () => mockController,
}));

vi.mock("@/features/agents/hooks/useProviderSelection", () => ({
  useProviderSelection: () => ({
    providers: [
      { id: "goose", label: "Goose" },
      { id: "claude-acp", label: "Claude Code" },
    ],
    providersLoading: false,
    selectedProvider: "goose",
    setSelectedProvider,
    setSelectedProviderWithoutPersist,
  }),
}));

vi.mock("@/features/agents/stores/agentStore", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/features/agents/stores/agentStore")
    >();
  return {
    ...actual,
    useAgentStore: Object.assign(
      (selector?: (s: unknown) => unknown) => {
        const state = {
          personas: [
            {
              id: "builtin-solo",
              displayName: "Solo",
              systemPrompt: "You are Solo.",
              provider: "openai",
              description: null,
              avatar: null,
              createdBy: null,
              source: "custom",
              extensions: [],
              metadata: null,
              sortOrder: 0,
              isDefault: false,
            },
            {
              id: "builtin-goose",
              displayName: "Goosey",
              systemPrompt: "You are Goosey.",
              isBuiltin: true,
              writable: false,
              description: null,
              avatar: null,
              createdBy: null,
              source: "custom",
              extensions: [],
              metadata: null,
              sortOrder: 1,
              isDefault: false,
              createdAt: "",
              updatedAt: "",
            },
          ],
          personasLoading: false,
        };
        return selector ? selector(state) : state;
      },
      { getState: () => ({}) },
    ),
  };
});

describe("HomeScreen", () => {
  const renderHome = () =>
    render(<HomeScreen sessionId="home-session" onActivateSession={vi.fn()} />);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 29, 14, 30, 0)); // 2:30 PM
    localStorage.clear();
    localStorage.setItem("goose:defaultProvider", "goose");
    setSelectedProvider.mockReset();
    setSelectedProviderWithoutPersist.mockReset();
    mockController.handleSend.mockReset();
    mockController.queue.dismiss.mockReset();
    mockController.queue.queuedRecords = [];
    mockController.deferredWorkspaceRecord = null;
    mockOpenDialog.mockReset();
    mockOpenDialog.mockResolvedValue(null);
    mockInspectAttachmentPaths.mockReset();
    mockInspectAttachmentPaths.mockResolvedValue([]);
    mockReadImageAttachment.mockReset();
    mockReadImageAttachment.mockResolvedValue({
      base64: "home-image",
      mimeType: "image/png",
    });
  });

  it("hides a deferred message while its naming dialog owns it", () => {
    mockController.deferredWorkspaceRecord = {
      payload: { text: "name this workspace" },
      state: { status: "naming" },
    };

    renderHome();

    expect(screen.queryByText(/name this workspace/)).not.toBeInTheDocument();
  });

  it("does not allow editing a deferred message while creating workspaces", () => {
    mockController.deferredWorkspaceRecord = {
      payload: { text: "create this workspace" },
      state: { status: "creating" },
    };
    mockController.queue.queuedRecords = [
      {
        kind: "deferred",
        recordId: "deferred-1",
        payload: { text: "create this workspace" },
        state: { status: "creating" },
      },
    ];

    renderHome();

    expect(
      screen.queryByText("Creating project workspaces…"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Dismiss queued message" }),
    ).not.toBeInTheDocument();
  });

  it("renders the clock", () => {
    renderHome();
    expect(screen.getByText("2:30")).toBeInTheDocument();
    expect(screen.getByText("PM")).toBeInTheDocument();
  });

  it("shows afternoon greeting at 2:30 PM", () => {
    renderHome();
    expect(screen.getByText("Good afternoon")).toBeInTheDocument();
  });

  it("renders the chat input placeholder with default agent name when no persona selected", () => {
    renderHome();
    expect(
      screen.getByPlaceholderText(
        "Chat with Goose, @ for agents/files, or / for skills",
      ),
    ).toBeInTheDocument();
  });

  it("renders the agent/model chooser affordance", () => {
    renderHome();
    expect(
      screen.getByRole("button", { name: /choose agent and model/i }),
    ).toBeInTheDocument();
  });

  it("renders the provider and project controls on the home screen", () => {
    renderHome();
    expect(
      screen.getByRole("button", { name: /choose agent and model/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /select project/i }),
    ).toBeInTheDocument();
  });

  it("forwards agent selection through the shared session controller", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();

    renderHome();

    await user.click(
      screen.getByRole("button", { name: /choose agent and model/i }),
    );
    await user.click(screen.getByRole("button", { name: /claude code/i }));

    expect(setSelectedProvider).toHaveBeenLastCalledWith("claude-acp");
  });

  it("uses ChatInput attachments on the home composer", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    mockOpenDialog.mockResolvedValue("/Users/test/home.png");
    mockInspectAttachmentPaths.mockResolvedValue([
      {
        name: "home.png",
        path: "/Users/test/home.png",
        kind: "file",
        mimeType: "image/png",
      },
    ]);

    renderHome();

    await user.click(screen.getByRole("button", { name: /^attach$/i }));
    await user.click(screen.getByRole("menuitem", { name: /^file$/i }));

    await waitFor(() => {
      expect(screen.getByAltText("Attachment 1")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(mockController.handleSend).toHaveBeenCalledWith(
      "",
      null,
      expect.arrayContaining([
        expect.objectContaining({
          kind: "image",
          name: "home.png",
          path: "/Users/test/home.png",
          base64: "home-image",
        }),
      ]),
    );
  });
});
