import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { GlobalComposerPill } from "./GlobalComposerPill";

const mockOpenDialog = vi.fn();
const mockInspectAttachmentPaths = vi.fn();
const mockReadImageAttachment = vi.fn();
const mockSearchFilesForMentions = vi.fn();
const mockResizeImage = vi.fn();
const mockGetModelsForAgent = vi.fn();
const mockRefreshAllModelProviders = vi.fn();
const mockRefreshAgentProviderStatus = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => mockOpenDialog(...args),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return {
    ...actual,
    convertFileSrc: (path: string) => `asset://${path}`,
  };
});

vi.mock("@/shared/api/system", () => ({
  inspectAttachmentPaths: (paths: string[]) =>
    mockInspectAttachmentPaths(paths),
  readImageAttachment: (path: string) => mockReadImageAttachment(path),
  getHomeDir: vi.fn().mockResolvedValue("/Users/wesb"),
  searchFilesForMentions: (input: {
    roots: string[];
    query: string;
    maxResults?: number;
  }) => mockSearchFilesForMentions(input),
}));

vi.mock("@/features/chat/lib/resizeImage", () => ({
  resizeImage: (file: File) => mockResizeImage(file),
}));

vi.mock("@/features/skills/api/skills", () => ({
  listSkills: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/features/chat/hooks/useVoiceDictation", () => ({
  useVoiceDictation: () => ({
    isEnabled: false,
    isRecording: false,
    isTranscribing: false,
    isStarting: () => false,
    stopRecording: vi.fn(),
    toggleRecording: vi.fn(),
  }),
}));

vi.mock("@/features/providers/hooks/useProviderModels", () => ({
  useProviderModels: () => ({
    configuredModelProviderIds: ["openai", "anthropic"],
    modelCacheRefreshProviderIds: ["openai", "anthropic"],
    getModelsForAgent: (agentId: string) => mockGetModelsForAgent(agentId),
    refreshAllModelProviders: (...args: unknown[]) =>
      mockRefreshAllModelProviders(...args),
    isRefreshingProvider: () => false,
    getError: () => null,
  }),
}));

vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => ({
    readyAgentIds: new Set(["goose", "claude-acp"]),
    agentReadiness: new Map([
      ["goose", "ready"],
      ["claude-acp", "ready"],
    ]),
    loading: false,
    refresh: mockRefreshAgentProviderStatus,
  }),
}));

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: vi.fn().mockResolvedValue({
    goose: {
      GooseUnstableDefaultsRead: vi.fn().mockResolvedValue({}),
    },
  }),
}));

vi.mock("@/features/chat/hooks/ArtifactPolicyContext", () => ({
  useArtifactPolicyContext: () => ({
    getAllSessionArtifacts: () => [],
  }),
}));

function setProjectStore() {
  useProjectStore.setState({
    projects: [
      {
        id: "project-1",
        path: "/tmp/project.yaml",
        name: "Project One",
        description: "",
        prompt: "",
        icon: "",
        color: "",
        preferredProvider: null,
        preferredModel: null,
        workingDirs: ["/workspace/project"],
        useWorktrees: false,
        order: 0,
        archivedAt: null,
      },
    ],
    loading: false,
    activeProjectId: null,
  });
}

function renderGlobalComposer(
  onSend = vi.fn(),
  props: Partial<ComponentProps<typeof GlobalComposerPill>> = {},
) {
  render(<GlobalComposerPill onSend={onSend} {...props} />);
  return onSend;
}

function setPersonas() {
  useAgentStore.setState({
    personas: [
      {
        id: "persona-1",
        displayName: "Research Scout",
        systemPrompt: "Gather context.",
        isBuiltin: false,
        writable: true,
      },
      {
        id: "persona-2",
        displayName: "UX Critic",
        systemPrompt: "Review flows.",
        isBuiltin: false,
        writable: true,
      },
    ],
  });
}

function mockImagePath(path: string, name: string) {
  mockInspectAttachmentPaths.mockResolvedValue([
    {
      name,
      path,
      kind: "file",
      mimeType: "image/png",
    },
  ]);
}

function expectSentImageAttachment(
  onSend: ReturnType<typeof vi.fn>,
  expected: Record<string, unknown>,
) {
  expect(onSend).toHaveBeenCalledWith("", {
    attachments: [expect.objectContaining({ kind: "image", ...expected })],
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("GlobalComposerPill", () => {
  beforeEach(() => {
    mockOpenDialog.mockReset();
    mockInspectAttachmentPaths.mockReset();
    mockReadImageAttachment.mockReset();
    mockSearchFilesForMentions.mockReset();
    mockResizeImage.mockReset();
    mockGetModelsForAgent.mockReset();
    mockGetModelsForAgent.mockReturnValue([]);
    mockRefreshAllModelProviders.mockReset();
    mockRefreshAllModelProviders.mockResolvedValue(undefined);
    mockRefreshAgentProviderStatus.mockReset();
    mockRefreshAgentProviderStatus.mockResolvedValue(undefined);
    mockOpenDialog.mockResolvedValue(null);
    mockInspectAttachmentPaths.mockResolvedValue([]);
    mockReadImageAttachment.mockResolvedValue({
      base64: "path-image",
      mimeType: "image/png",
    });
    mockSearchFilesForMentions.mockResolvedValue([]);
    mockResizeImage.mockImplementation((file: File) =>
      Promise.resolve({ base64: `base64:${file.name}`, mimeType: file.type }),
    );
    vi.unstubAllGlobals();
    delete window.__TAURI_INTERNALS__;
    localStorage.clear();
    localStorage.setItem("goose:defaultProvider", "goose");
    useAgentStore.setState({
      personas: [],
      providers: [
        { id: "goose", label: "Goose" },
        { id: "claude-acp", label: "Claude Code" },
      ],
      providersLoading: false,
      selectedProvider: "goose",
    });
    setProjectStore();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    });
  });

  it("preselects a suggested persona and sends with that persona", async () => {
    const user = userEvent.setup();
    setPersonas();
    const onSend = renderGlobalComposer(vi.fn(), {
      suggestedPersonaId: "persona-1",
    });

    expect(screen.getByText("Research Scout")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox"), "Hello");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(onSend).toHaveBeenCalledWith("Hello", {
      personaId: "persona-1",
    });
  });

  it("hides the native scrollbar for long global composer drafts", () => {
    renderGlobalComposer(vi.fn());

    const input = screen.getByRole("textbox");

    expect(input).toHaveClass("scrollbar-none", "overscroll-contain");
    expect(input).not.toHaveClass("scrollbar-subtle");
  });

  it("switches @ mention tabs without inserting extra text", async () => {
    const user = userEvent.setup();
    setPersonas();
    renderGlobalComposer(vi.fn());

    const input = screen.getByRole("textbox");
    await user.type(input, "@");

    expect(screen.getByRole("tab", { name: "Agents" })).toHaveAttribute(
      "data-state",
      "active",
    );

    await user.keyboard("@");
    expect(input).toHaveValue("@");
    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute(
      "data-state",
      "active",
    );

    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Agents" })).toHaveAttribute(
      "data-state",
      "active",
    );

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute(
      "data-state",
      "active",
    );

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Skills" })).toHaveAttribute(
      "data-state",
      "active",
    );
  });

  it("applies the suggested persona's provider and model to the send payload", async () => {
    const user = userEvent.setup();
    useAgentStore.setState({
      personas: [
        {
          id: "persona-1",
          displayName: "Research Scout",
          systemPrompt: "Gather context.",
          provider: "claude-acp",
          model: "claude-sonnet-4",
          isBuiltin: false,
          writable: true,
        },
      ],
    });
    const onSend = renderGlobalComposer(vi.fn(), {
      suggestedPersonaId: "persona-1",
    });

    expect(screen.getByText("Research Scout")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox"), "Hello");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(onSend).toHaveBeenCalledWith("Hello", {
      providerId: "claude-acp",
      modelId: "claude-sonnet-4",
      modelName: "claude-sonnet-4",
      personaId: "persona-1",
    });
  });

  it("refreshes the suggested persona provider/model when the same persona changes", async () => {
    const user = userEvent.setup();
    useAgentStore.setState({
      personas: [
        {
          id: "persona-1",
          displayName: "Research Scout",
          systemPrompt: "Gather context.",
          provider: "claude-acp",
          model: "claude-sonnet-4",
          isBuiltin: false,
          writable: true,
        },
      ],
    });
    const onSend = renderGlobalComposer(vi.fn(), {
      suggestedPersonaId: "persona-1",
    });

    act(() => {
      useAgentStore.setState({
        personas: [
          {
            id: "persona-1",
            displayName: "Research Scout",
            systemPrompt: "Gather context.",
            provider: "goose",
            model: "goose-claude-opus-4-8",
            isBuiltin: false,
            writable: true,
          },
        ],
      });
    });

    await user.type(screen.getByRole("textbox"), "Hello");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(onSend).toHaveBeenCalledWith("Hello", {
      providerId: "goose",
      modelId: "goose-claude-opus-4-8",
      modelName: "goose-claude-opus-4-8",
      personaId: "persona-1",
    });
  });

  it("uses a suggested persona's implicit Goose model instead of the stored default model", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "goose:preferredModelsByAgent",
      JSON.stringify({
        goose: {
          modelId: "gpt-5.5",
          modelName: "GPT 5.5",
          providerId: "openai",
        },
      }),
    );
    mockGetModelsForAgent.mockImplementation((agentId: string) =>
      agentId === "goose"
        ? [
            {
              id: "gpt-5.5",
              name: "GPT 5.5",
              providerId: "openai",
              recommended: true,
            },
          ]
        : [],
    );
    useAgentStore.setState({
      providers: [
        { id: "openai", label: "OpenAI" },
        { id: "anthropic", label: "Anthropic" },
      ],
      personas: [
        {
          id: "persona-1",
          displayName: "Everyday Otter",
          systemPrompt: "Be brief.",
          provider: "Goose",
          model: "goose-claude-opus-4-8",
          isBuiltin: false,
          writable: true,
        },
      ],
    });
    const onSend = renderGlobalComposer(vi.fn(), {
      suggestedPersonaId: "persona-1",
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /choose agent and model/i }),
      ).toHaveTextContent("Claude Opus 4.8");
    });

    await user.type(screen.getByRole("textbox"), "Hello");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(onSend).toHaveBeenCalledWith("Hello", {
      providerId: "goose",
      modelId: "goose-claude-opus-4-8",
      modelName: "goose-claude-opus-4-8",
      personaId: "persona-1",
    });
  });

  it("does not apply a persona model when the persona provider cannot resolve", async () => {
    const user = userEvent.setup();
    useAgentStore.setState({
      personas: [
        {
          id: "persona-1",
          displayName: "Research Scout",
          systemPrompt: "Gather context.",
          provider: "missing-provider",
          model: "goose-claude-opus-4-8",
          isBuiltin: false,
          writable: true,
        },
      ],
    });
    const onSend = renderGlobalComposer(vi.fn(), {
      suggestedPersonaId: "persona-1",
    });

    await user.type(screen.getByRole("textbox"), "Hello");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(onSend).toHaveBeenCalledWith("Hello", {
      personaId: "persona-1",
    });
  });

  it("does not leak a previous persona's provider/model when switching to a provider-less persona", async () => {
    const user = userEvent.setup();
    useAgentStore.setState({
      personas: [
        {
          id: "persona-1",
          displayName: "Research Scout",
          systemPrompt: "Gather context.",
          provider: "claude-acp",
          model: "claude-sonnet-4",
          isBuiltin: false,
          writable: true,
        },
        {
          id: "persona-2",
          displayName: "UX Critic",
          systemPrompt: "Review flows.",
          isBuiltin: false,
          writable: true,
        },
      ],
    });
    const onSend = vi.fn();
    const { rerender } = render(
      <GlobalComposerPill onSend={onSend} suggestedPersonaId="persona-1" />,
    );

    expect(screen.getByText("Research Scout")).toBeInTheDocument();

    rerender(
      <GlobalComposerPill onSend={onSend} suggestedPersonaId="persona-2" />,
    );

    expect(screen.getByText("UX Critic")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox"), "Hello");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(onSend).toHaveBeenCalledWith("Hello", {
      personaId: "persona-2",
    });
  });

  it("applies the new persona's provider/model when switching between personas", async () => {
    const user = userEvent.setup();
    useAgentStore.setState({
      personas: [
        {
          id: "persona-1",
          displayName: "Research Scout",
          systemPrompt: "Gather context.",
          provider: "claude-acp",
          model: "claude-sonnet-4",
          isBuiltin: false,
          writable: true,
        },
        {
          id: "persona-2",
          displayName: "UX Critic",
          systemPrompt: "Review flows.",
          provider: "goose",
          model: "goose-default",
          isBuiltin: false,
          writable: true,
        },
      ],
    });
    const onSend = vi.fn();
    const { rerender } = render(
      <GlobalComposerPill onSend={onSend} suggestedPersonaId="persona-1" />,
    );

    expect(screen.getByText("Research Scout")).toBeInTheDocument();

    rerender(
      <GlobalComposerPill onSend={onSend} suggestedPersonaId="persona-2" />,
    );

    expect(screen.getByText("UX Critic")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox"), "Hello");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(onSend).toHaveBeenCalledWith("Hello", {
      providerId: "goose",
      modelId: "goose-default",
      modelName: "goose-default",
      personaId: "persona-2",
    });
  });

  it("restores the default provider/model after clearing the suggested persona", async () => {
    const user = userEvent.setup();
    useAgentStore.setState({
      personas: [
        {
          id: "persona-1",
          displayName: "Research Scout",
          systemPrompt: "Gather context.",
          provider: "claude-acp",
          model: "claude-sonnet-4",
          isBuiltin: false,
          writable: true,
        },
      ],
    });
    const onSend = renderGlobalComposer(vi.fn(), {
      suggestedPersonaId: "persona-1",
    });

    await user.click(
      screen.getByRole("button", { name: /clear active assistant/i }),
    );
    await user.type(screen.getByRole("textbox"), "Hello");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(onSend).toHaveBeenCalledWith("Hello");
  });

  it("does not reselect the suggested persona after the user clears it", async () => {
    const user = userEvent.setup();
    setPersonas();
    const { rerender } = render(
      <GlobalComposerPill onSend={vi.fn()} suggestedPersonaId="persona-1" />,
    );

    await user.click(
      screen.getByRole("button", { name: /clear active assistant/i }),
    );
    rerender(
      <GlobalComposerPill onSend={vi.fn()} suggestedPersonaId="persona-1" />,
    );

    expect(screen.queryByText("Research Scout")).not.toBeInTheDocument();
  });

  it("focuses the textarea when focusRequest increments", () => {
    const { rerender } = render(
      <GlobalComposerPill onSend={vi.fn()} focusRequest={0} />,
    );
    const textbox = screen.getByRole("textbox");

    rerender(<GlobalComposerPill onSend={vi.fn()} focusRequest={1} />);

    expect(textbox).toHaveFocus();
  });

  it("does not focus the textarea when mounted with a consumed focusRequest", () => {
    render(<GlobalComposerPill onSend={vi.fn()} focusRequest={1} />);

    expect(screen.getByRole("textbox")).not.toHaveFocus();
  });

  it("disables send until there is sendable content", async () => {
    const user = userEvent.setup();
    const onSend = renderGlobalComposer();
    const textbox = screen.getByRole("textbox");

    const collapsedSendButton = screen.getByRole("button", {
      name: /send message/i,
    });
    expect(collapsedSendButton).toBeDisabled();
    expect(collapsedSendButton).toHaveClass("disabled:opacity-100");

    await user.click(textbox);
    const expandedDisabledSendButton = screen.getByRole("button", {
      name: /send message/i,
    });
    expect(expandedDisabledSendButton).toBeDisabled();
    expect(expandedDisabledSendButton).toHaveClass("disabled:opacity-100");

    await user.type(textbox, "Hello");
    const sendButton = screen.getByRole("button", { name: /send message/i });
    expect(sendButton).toBeEnabled();

    await user.click(sendButton);
    expect(onSend).toHaveBeenCalledWith("Hello");
  });

  it("sends the selected reasoning effort from the mini composer", async () => {
    const user = userEvent.setup();
    const onSend = renderGlobalComposer(vi.fn(), {
      reasoningEffort: {
        config: {
          configId: "thinking_effort",
          currentValue: "high",
          options: [
            { id: "low", name: "low" },
            { id: "medium", name: "medium" },
            { id: "high", name: "high" },
          ],
        },
        onChange: vi.fn(),
      },
    });

    await user.click(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "Think hard");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(onSend).toHaveBeenCalledWith("Think hard", {
      reasoningEffort: {
        configId: "thinking_effort",
        value: "high",
      },
    });
  });

  it("omits stale reasoning effort after switching to a different local model", async () => {
    const user = userEvent.setup();
    mockGetModelsForAgent.mockImplementation((agentId: string) =>
      agentId === "goose"
        ? [
            {
              id: "gpt-5",
              name: "GPT 5",
              providerId: "openai",
              providerName: "OpenAI",
              recommended: true,
            },
            {
              id: "claude-sonnet-4",
              name: "Claude Sonnet 4",
              displayName: "Claude Sonnet 4",
              providerId: "anthropic",
              providerName: "Anthropic",
              recommended: true,
            },
          ]
        : [],
    );
    const onSend = renderGlobalComposer(vi.fn(), {
      reasoningEffort: {
        config: {
          configId: "thinking_effort",
          currentValue: "high",
          options: [
            { id: "low", name: "low" },
            { id: "medium", name: "medium" },
            { id: "high", name: "high" },
          ],
        },
        onChange: vi.fn(),
      },
      reasoningEffortModelSelection: {
        providerId: "openai",
        modelId: "gpt-5",
      },
    });

    await user.click(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "Use Sonnet");
    await user.click(
      screen.getByRole("button", { name: /choose agent and model/i }),
    );
    await user.click(screen.getByRole("button", { name: "Claude Sonnet 4" }));
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(onSend).toHaveBeenCalledWith("Use Sonnet", {
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      modelName: "Claude Sonnet 4",
    });
  });

  it("attaches an image through the picker and sends it without text", async () => {
    const user = userEvent.setup();
    const onSend = renderGlobalComposer();
    mockOpenDialog.mockResolvedValue("/Users/test/diagram.png");
    mockImagePath("/Users/test/diagram.png", "diagram.png");

    await user.click(screen.getByRole("textbox"));
    await user.click(
      screen.getByRole("button", { name: "Choose files to attach" }),
    );

    await waitFor(() => {
      expect(screen.getByAltText("Attachment 1")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /send message/i }));

    expectSentImageAttachment(onSend, {
      name: "diagram.png",
      path: "/Users/test/diagram.png",
      base64: "path-image",
    });
  });

  it("turns pasted image files into image attachments", async () => {
    const user = userEvent.setup();
    const onSend = renderGlobalComposer();
    const textbox = screen.getByRole("textbox");
    const pastedImage = new File(["image"], "pasted.png", {
      type: "image/png",
    });

    fireEvent.paste(textbox, {
      clipboardData: {
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => pastedImage,
          },
        ],
      },
    });

    await waitFor(() => {
      expect(screen.getByAltText("Attachment 1")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /send message/i }));

    expectSentImageAttachment(onSend, {
      name: "pasted.png",
      base64: "base64:pasted.png",
    });
  });

  it("does not send while pasted image attachment work is pending", async () => {
    const user = userEvent.setup();
    const resize = deferred<{ base64: string; mimeType: string }>();
    mockResizeImage.mockReturnValueOnce(resize.promise);
    const onSend = renderGlobalComposer();
    const textbox = screen.getByRole("textbox");
    const pastedImage = new File(["image"], "pending.png", {
      type: "image/png",
    });

    fireEvent.paste(textbox, {
      clipboardData: {
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => pastedImage,
          },
        ],
      },
    });

    await user.click(screen.getByRole("button", { name: /send message/i }));
    expect(onSend).not.toHaveBeenCalled();

    resize.resolve({ base64: "pending-base64", mimeType: "image/png" });
    await waitFor(() => {
      expect(screen.getByAltText("Attachment 1")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /send message/i }));

    expectSentImageAttachment(onSend, {
      name: "pending.png",
      base64: "pending-base64",
    });
  });

  it("adds dropped browser files through the shared attachment hook", async () => {
    const user = userEvent.setup();
    const onSend = renderGlobalComposer();
    const region = screen.getByRole("region", { name: /quick compose/i });
    const droppedImage = new File(["image"], "dropped.png", {
      type: "image/png",
    });
    const dropEvent = createEvent.drop(region, {
      dataTransfer: {
        files: [droppedImage],
        items: [{ kind: "file" }],
        types: ["Files"],
      },
    });

    fireEvent(region, dropEvent);

    await waitFor(() => {
      expect(screen.getByAltText("Attachment 1")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /send message/i }));

    expectSentImageAttachment(onSend, {
      name: "dropped.png",
      base64: "base64:dropped.png",
    });
  });

  it("shows the attachment drop overlay during browser file drag", () => {
    renderGlobalComposer();
    const region = screen.getByRole("region", { name: /quick compose/i });

    fireEvent.dragEnter(region, {
      dataTransfer: {
        files: [],
        items: [{ kind: "file" }],
        types: ["Files"],
      },
    });
    fireEvent.dragOver(region, {
      dataTransfer: {
        files: [],
        items: [{ kind: "file" }],
        types: ["Files"],
      },
    });

    expect(
      screen.getByText("Drop files or folders to attach"),
    ).toBeInTheDocument();
  });

  it("attaches selected project file mentions as chips", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    renderGlobalComposer(onSend);
    mockSearchFilesForMentions.mockResolvedValue([
      {
        resolvedPath: "/workspace/project/src/readme.md",
        displayPath: "project/src/readme.md",
        filename: "readme.md",
        kind: "file",
        source: "project",
      },
    ]);
    mockInspectAttachmentPaths.mockResolvedValue([
      {
        name: "readme.md",
        path: "/workspace/project/src/readme.md",
        kind: "file",
        mimeType: "text/markdown",
      },
    ]);

    await user.click(screen.getByRole("textbox"));
    await user.click(screen.getByRole("button", { name: /select project/i }));
    await user.click(screen.getByRole("menuitem", { name: /Project One/i }));

    expect(mockSearchFilesForMentions).not.toHaveBeenCalled();

    await user.type(screen.getByRole("textbox"), "@@read");

    await waitFor(() => {
      expect(mockSearchFilesForMentions).toHaveBeenCalledWith({
        roots: ["/workspace/project"],
        query: "read",
        maxResults: 12,
      });
    });

    await user.click(
      await screen.findByRole("option", { name: /readme\.md/i }),
    );

    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(await screen.findByText("readme.md")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(onSend).toHaveBeenCalledWith(
      "",
      expect.objectContaining({
        attachments: [
          expect.objectContaining({
            kind: "file",
            name: "readme.md",
            path: "/workspace/project/src/readme.md",
          }),
        ],
      }),
    );
  });

  it("uses textarea-safe aria for mention suggestions", async () => {
    const user = userEvent.setup();
    renderGlobalComposer();

    await user.click(screen.getByRole("textbox"));
    await user.click(screen.getByRole("button", { name: /select project/i }));
    await user.click(screen.getByRole("menuitem", { name: /Project One/i }));
    await user.type(screen.getByRole("textbox"), "@");

    const input = screen.getByRole("textbox");
    expect(input).not.toHaveAttribute("aria-expanded");
    expect(input).not.toHaveAttribute("aria-autocomplete");
    expect(input).not.toHaveAttribute("aria-activedescendant");
    expect(input).toHaveAttribute("aria-controls");
    expect(input).toHaveAttribute("aria-describedby");

    const status = document.getElementById(
      input.getAttribute("aria-describedby") as string,
    );
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("listbox")).toHaveAttribute(
      "id",
      input.getAttribute("aria-controls"),
    );
  });

  it("uses the shared project selector menu", async () => {
    const user = userEvent.setup();
    renderGlobalComposer();

    await user.click(screen.getByRole("textbox"));
    await user.click(screen.getByRole("button", { name: /select project/i }));

    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("Choose a project")).toBeInTheDocument();
    expect(within(menu).getByText("No project")).toBeInTheDocument();
    expect(
      within(menu).getByText("General chat without project context"),
    ).toBeInTheDocument();
    expect(within(menu).getByText("/workspace/project")).toBeInTheDocument();
    expect(
      document.querySelector('[data-project-color-swatch="project-1"]'),
    ).toBeInTheDocument();
  });

  it("sends a provider override when the mini composer switches agents", async () => {
    const user = userEvent.setup();
    const onSend = renderGlobalComposer();
    const textbox = screen.getByRole("textbox");

    await user.click(textbox);
    await user.type(textbox, "Use Claude");
    await user.click(
      screen.getByRole("button", { name: /choose agent and model/i }),
    );
    await user.click(screen.getByRole("button", { name: "Claude Code" }));
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(onSend).toHaveBeenCalledWith("Use Claude", {
      providerId: "claude-acp",
    });
  });

  it("shows the model name in the mini composer picker trigger", async () => {
    const user = userEvent.setup();
    mockGetModelsForAgent.mockImplementation((agentId: string) =>
      agentId === "goose"
        ? [
            {
              id: "claude-sonnet-4",
              name: "Claude Sonnet 4",
              providerId: "anthropic",
              providerName: "Anthropic",
              recommended: true,
            },
          ]
        : [],
    );
    renderGlobalComposer();

    await user.click(screen.getByRole("textbox"));

    const trigger = screen.getByRole("button", {
      name: /choose agent and model/i,
    });
    expect(trigger).toHaveTextContent("Claude Sonnet 4");
  });

  it("sends the selected model provider from the shared model picker", async () => {
    const user = userEvent.setup();
    mockGetModelsForAgent.mockImplementation((agentId: string) =>
      agentId === "goose"
        ? [
            {
              id: "gpt-5",
              name: "GPT 5",
              providerId: "openai",
              providerName: "OpenAI",
              recommended: true,
            },
            {
              id: "claude-sonnet-4",
              name: "Claude Sonnet 4",
              displayName: "Claude Sonnet 4",
              providerId: "anthropic",
              providerName: "Anthropic",
              recommended: true,
            },
          ]
        : [],
    );
    const onSend = renderGlobalComposer();
    const textbox = screen.getByRole("textbox");

    await user.click(textbox);
    await user.type(textbox, "Use Sonnet");
    await user.click(
      screen.getByRole("button", { name: /choose agent and model/i }),
    );
    await user.click(screen.getByRole("button", { name: "Claude Sonnet 4" }));
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(onSend).toHaveBeenCalledWith("Use Sonnet", {
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      modelName: "Claude Sonnet 4",
    });
  });
});
