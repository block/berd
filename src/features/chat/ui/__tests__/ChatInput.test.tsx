import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ChatInput } from "./chatInputTestUtils";
import { ChatInputToolbar } from "../ChatInputToolbar";
import { OPEN_SETTINGS_EVENT } from "@/features/settings/lib/settingsEvents";
import type { Persona } from "@/shared/types/agents";

const mockVoiceDictation = {
  isEnabled: true,
  isRecording: false,
  isTranscribing: false,
  isStarting: vi.fn(() => false),
  stopRecording: vi.fn(),
  toggleRecording: vi.fn(),
};

vi.mock("../hooks/useVoiceDictation", () => ({
  useVoiceDictation: () => mockVoiceDictation,
}));

// Deterministic shortcut modifiers across dev machines and CI: "mod"
// combos (e.g. chat.sendNow's Mod+Enter) resolve to Meta.
vi.mock("@/shared/lib/platform", () => ({
  getPlatform: () => "mac",
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

const mockSearchFilesForMentions = vi.fn<
  (input: {
    roots: string[];
    query: string;
    maxResults?: number;
  }) => Promise<unknown[]>
>(async () => []);
vi.mock("@/shared/api/system", () => ({
  getHomeDir: vi.fn().mockResolvedValue("/Users/wesb"),
  searchFilesForMentions: (input: {
    roots: string[];
    query: string;
    maxResults?: number;
  }) => mockSearchFilesForMentions(input),
}));

vi.mock("@/features/skills/api/skills", () => ({
  listSkills: vi.fn().mockResolvedValue([]),
}));

const TEST_PERSONAS: Persona[] = [
  {
    id: "builtin-solo",
    displayName: "Solo",
    systemPrompt: "You are Solo.",
    isBuiltin: true,
    writable: false,
    createdAt: "",
    updatedAt: "",
  },
  {
    id: "reviewer",
    displayName: "Reviewer",
    systemPrompt: "You are Reviewer, a code review specialist.",
    isBuiltin: true,
    writable: false,
    createdAt: "",
    updatedAt: "",
  },
];

function StatefulChatInput({
  onSend = vi.fn(),
}: {
  onSend?: (text: string, personaId?: string) => boolean | Promise<boolean>;
}) {
  const [selectedPersonaId, setSelectedPersonaId] = useState<string | null>(
    "builtin-solo",
  );

  return (
    <ChatInput
      onSend={onSend}
      personas={TEST_PERSONAS}
      selectedPersonaId={selectedPersonaId}
      onPersonaChange={setSelectedPersonaId}
    />
  );
}

const PROJECT_FILE_MENTION_ENTRIES = [
  {
    resolvedPath: "/Users/wesb/dev/goose2/README.md",
    displayPath: "goose2/README.md",
    filename: "README.md",
    kind: "file",
    source: "project",
  },
  {
    resolvedPath: "/Users/wesb/dev/goose2/src",
    displayPath: "goose2/src",
    filename: "src",
    kind: "folder",
    source: "project",
  },
  {
    resolvedPath: "/Users/wesb/dev/goose2/src/features/chat/ui/ChatInput.tsx",
    displayPath: "goose2/src/features/chat/ui/ChatInput.tsx",
    filename: "ChatInput.tsx",
    kind: "file",
    source: "project",
  },
];

function renderProjectChatInput(onSend = vi.fn()) {
  return render(
    <ChatInput
      onSend={onSend}
      selectedProjectId="project-1"
      availableProjects={[
        {
          id: "project-1",
          name: "goose2",
          workingDirs: ["/Users/wesb/dev/goose2"],
        },
      ]}
    />,
  );
}

function renderLongPathProjectChatInput() {
  return render(
    <ChatInput
      onSend={vi.fn()}
      selectedProjectId="project-1"
      availableProjects={[
        {
          id: "project-1",
          name: "goose-internal",
          workingDirs: ["/Users/wesb/Development/squareup/goose-internal"],
        },
      ]}
    />,
  );
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

function recallTextbox(): HTMLTextAreaElement {
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

function pressRecallArrowUp(eventInit: Record<string, unknown> = {}) {
  fireEvent.keyDown(recallTextbox(), { key: "ArrowUp", ...eventInit });
}

function renderQueuedRecallInput(
  props: Partial<Parameters<typeof ChatInput>[0]> = {},
) {
  const onDismissQueue = vi.fn();
  const onRecallLastUserMessage = vi.fn(() => "my previous message");
  render(
    <ChatInput
      onSend={vi.fn()}
      queuedMessage={{ text: "queued follow up" }}
      onDismissQueue={onDismissQueue}
      onRecallLastUserMessage={onRecallLastUserMessage}
      {...props}
    />,
  );
  return { onDismissQueue, onRecallLastUserMessage };
}

function expectNoRecallShortcutAction({
  onDismissQueue,
  onRecallLastUserMessage,
}: ReturnType<typeof renderQueuedRecallInput>) {
  expect(onDismissQueue).not.toHaveBeenCalled();
  expect(onRecallLastUserMessage).not.toHaveBeenCalled();
}

async function stageRecallAttachment() {
  const composer = recallTextbox().closest("div.rounded-composer");
  if (!composer) {
    throw new Error("Expected composer container");
  }

  fireEvent.drop(composer, {
    dataTransfer: {
      files: [new File(["draft"], "draft.txt", { type: "text/plain" })],
      items: [{ kind: "file" }],
      types: ["Files"],
    },
  });

  expect(await screen.findByText("draft.txt")).toBeInTheDocument();
}

describe("ChatInput", () => {
  beforeEach(() => {
    localStorage.clear();
    mockSearchFilesForMentions.mockClear();
    mockSearchFilesForMentions.mockResolvedValue([]);
    mockVoiceDictation.isEnabled = true;
    mockVoiceDictation.isRecording = false;
    mockVoiceDictation.isTranscribing = false;
    mockVoiceDictation.isStarting.mockReset();
    mockVoiceDictation.isStarting.mockReturnValue(false);
    mockVoiceDictation.stopRecording.mockReset();
    mockVoiceDictation.toggleRecording.mockReset();
  });

  it("renders with default placeholder", () => {
    render(<ChatInput onSend={vi.fn()} />);
    expect(
      screen.getByPlaceholderText(
        "Chat with Goose or @ to add files, paths, agents, or skills",
      ),
    ).toBeInTheDocument();
  });

  it("calls onSend when Enter is pressed", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<ChatInput onSend={onSend} />);

    const input = screen.getByRole("textbox");
    await user.type(input, "hello");
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith("hello", undefined, undefined);
  });

  it("does not call onSend on Shift+Enter (newline)", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<ChatInput onSend={onSend} />);

    const input = screen.getByRole("textbox");
    await user.type(input, "hello");
    await user.keyboard("{Shift>}{Enter}{/Shift}");

    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not call onSend on Alt+Enter (newline)", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<ChatInput onSend={onSend} />);

    const input = screen.getByRole("textbox");
    await user.type(input, "hello");
    const wasNotPrevented = fireEvent.keyDown(input, {
      altKey: true,
      key: "Enter",
    });

    expect(wasNotPrevented).toBe(true);
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue("hello");
  });

  it("does not send while IME composition is active", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<ChatInput onSend={onSend} />);

    const input = screen.getByRole("textbox");
    await user.type(input, "hello");
    fireEvent.keyDown(input, {
      key: "Enter",
      isComposing: true,
    });

    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows current model name in model picker", () => {
    render(
      <ChatInput
        onSend={vi.fn()}
        currentModelId="gpt-4o"
        currentModel="GPT-4o"
        availableModels={[{ id: "gpt-4o", name: "GPT-4o" }]}
        providers={[{ id: "goose", label: "Goose" }]}
      />,
    );
    expect(
      screen.getByRole("button", { name: /choose agent and model/i }),
    ).toHaveTextContent("GPT-4o");
  });

  it("shows the current model name when a persona is selected", () => {
    render(
      <ChatInput
        onSend={vi.fn()}
        personas={TEST_PERSONAS}
        selectedPersonaId="reviewer"
        onPersonaChange={vi.fn()}
        selectedProvider="goose"
        currentModelProviderId="goose"
        currentModelId="goose-claude-opus-4-8"
        currentModel="Claude Opus 4.8"
        availableModels={[
          {
            id: "goose-claude-opus-4-8",
            name: "Claude Opus 4.8",
            providerId: "goose",
          },
        ]}
        providers={[{ id: "goose", label: "Goose" }]}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: /choose agent and model/i,
    });
    expect(trigger).toHaveTextContent("Claude Opus 4.8");
    expect(trigger).not.toHaveTextContent("Goose");
  });

  it("shows an available model name when no current model is selected", () => {
    render(
      <ChatInput
        onSend={vi.fn()}
        availableModels={[
          { id: "gpt-5", name: "GPT 5" },
          {
            id: "claude-sonnet-4",
            name: "Claude Sonnet 4",
            recommended: true,
          },
        ]}
        providers={[{ id: "goose", label: "Goose" }]}
      />,
    );
    expect(
      screen.getByRole("button", { name: /choose agent and model/i }),
    ).toHaveTextContent("Claude Sonnet 4");
  });

  it("shows provider label while the current model id is unresolved", () => {
    render(
      <ChatInput
        onSend={vi.fn()}
        currentModelId="opus"
        currentModelProviderId="claude-acp"
        currentModel="opus"
        availableModels={[]}
        providers={[{ id: "claude-acp", label: "Claude Code" }]}
        selectedProvider="claude-acp"
      />,
    );

    const trigger = screen.getByRole("button", {
      name: /choose agent and model/i,
    });
    expect(trigger).toHaveTextContent("Claude Code");
    expect(trigger).not.toHaveTextContent("opus");
  });

  it("shows default provider label", () => {
    render(
      <ChatInput
        onSend={vi.fn()}
        providers={[{ id: "goose", label: "Goose" }]}
        selectedProvider="goose"
      />,
    );
    const providerButton = screen.getByRole("button", {
      name: /choose agent and model/i,
    });
    expect(providerButton).toHaveTextContent("Goose");
  });

  it("resets the textarea when initialValue changes", () => {
    const { rerender } = render(
      <ChatInput onSend={vi.fn()} initialValue="alpha draft" />,
    );

    expect(screen.getByRole("textbox")).toHaveValue("alpha draft");

    rerender(<ChatInput onSend={vi.fn()} initialValue="" />);

    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("opens the agent and model picker", async () => {
    const user = userEvent.setup();

    render(
      <ChatInput
        onSend={vi.fn()}
        providers={[
          { id: "goose", label: "Goose" },
          { id: "claude-acp", label: "Claude Code" },
        ]}
        selectedProvider="goose"
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /choose agent and model/i }),
    );

    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.getByText("Model")).toBeInTheDocument();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
  });

  it("opens the project selector menu", async () => {
    const user = userEvent.setup();

    render(
      <ChatInput
        onSend={vi.fn()}
        selectedProjectId="project-1"
        availableProjects={[
          {
            id: "project-1",
            name: "goose2",
            workingDirs: ["/Users/wesb/dev/goose2"],
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /select project/i }));

    expect(screen.getByText("Choose a project")).toBeInTheDocument();
    expect(screen.getByText("No project")).toBeInTheDocument();
  });

  it("shows project color swatches in the project selector menu", async () => {
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={vi.fn()}
        availableProjects={[
          {
            id: "project-1",
            name: "goose2",
            workingDirs: ["/Users/wesb/dev/goose2"],
            icon: "tabler:folder-code",
            color: "sage",
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /select project/i }));

    const swatch = document.querySelector(
      '[data-project-color-swatch="project-1"]',
    );
    expect(swatch).toBeInTheDocument();
    expect(swatch).toHaveClass("size-3.5", "rounded-[3px]");
    expect(swatch).not.toHaveClass("ring-1");
    expect(swatch).toHaveAttribute(
      "style",
      expect.stringContaining("--color-pill-sage"),
    );
  });

  it("shows no project in the toolbar when no project is selected", () => {
    render(<ChatInput onSend={vi.fn()} />);
    expect(screen.getByText("No project")).toBeInTheDocument();
  });

  it("can hide the project selector for scoped chat surfaces", () => {
    render(
      <ChatInput
        onSend={vi.fn()}
        enabled={false}
        providers={[{ id: "kgoose", label: "kgoose" }]}
        selectedProvider="kgoose"
      />,
    );

    expect(
      screen.getByRole("button", { name: /choose agent and model/i }),
    ).toHaveTextContent("kgoose");
    expect(screen.queryByText("No project")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /select project/i }),
    ).not.toBeInTheDocument();
  });

  it("can hide scoped controls and opt out of autofocus", () => {
    render(
      <ChatInput
        onSend={vi.fn()}
        controls={{
          agentModelPicker: false,
          attachments: false,
          autoFocus: false,
          fileMentions: false,
          projectPicker: false,
          skills: false,
          voice: false,
        }}
        providers={[{ id: "kgoose", label: "kgoose" }]}
        selectedProvider="kgoose"
      />,
    );

    expect(
      screen.queryByRole("button", { name: /choose agent and model/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /select project/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /attach/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /voice dictation/i }),
    ).toBeDisabled();
    expect(screen.getByRole("textbox")).not.toHaveFocus();
  });

  it("shows the selected project name in the toolbar", () => {
    render(
      <ChatInput
        onSend={vi.fn()}
        selectedProjectId="project-1"
        availableProjects={[
          {
            id: "project-1",
            name: "goose2",
            workingDirs: ["/Users/wesb/dev/goose2"],
          },
        ]}
      />,
    );
    expect(screen.getByText("goose2")).toBeInTheDocument();
  });

  it("opens a context usage popover when token tracking is available", async () => {
    const user = userEvent.setup();
    render(
      <ChatInput onSend={vi.fn()} contextTokens={1536} contextLimit={8192} />,
    );

    await user.click(screen.getByRole("button", { name: /context usage/i }));

    expect(screen.getByText("Context window")).toBeInTheDocument();
    expect(screen.getByText("1.5K / 8.2K tokens used")).toBeInTheDocument();
    expect(screen.getByText("19%")).toBeInTheDocument();
  });

  it("runs compaction from the context usage popover", async () => {
    const user = userEvent.setup();
    const onCompactContext = vi.fn();

    render(
      <ChatInput
        onSend={vi.fn()}
        contextTokens={1536}
        contextLimit={8192}
        canCompactContext
        onCompactContext={onCompactContext}
      />,
    );

    await user.click(screen.getByRole("button", { name: /context usage/i }));
    await user.click(screen.getByRole("button", { name: "Compact" }));

    expect(onCompactContext).toHaveBeenCalledOnce();
  });

  it("opens compaction settings from the context usage popover", async () => {
    const user = userEvent.setup();
    const dispatchEventSpy = vi.spyOn(window, "dispatchEvent");

    render(
      <ChatInput
        onSend={vi.fn()}
        selectedProvider="goose"
        contextTokens={1536}
        contextLimit={8192}
        canCompactContext
      />,
    );

    await user.click(screen.getByRole("button", { name: /context usage/i }));

    await user.click(screen.getByRole("button", { name: /settings/i }));

    expect(dispatchEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: OPEN_SETTINGS_EVENT,
        detail: { section: "general" },
      }),
    );

    dispatchEventSpy.mockRestore();
  });

  it("hides the context usage control when the context limit is unavailable", () => {
    render(
      <ChatInput onSend={vi.fn()} contextTokens={1536} contextLimit={0} />,
    );

    expect(
      screen.queryByRole("button", { name: /context usage/i }),
    ).not.toBeInTheDocument();
  });

  it("hides the context usage control until usage is ready", () => {
    render(
      <ChatInput
        onSend={vi.fn()}
        contextTokens={1536}
        contextLimit={8192}
        isContextUsageReady={false}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /context usage/i }),
    ).not.toBeInTheDocument();
  });

  it("shows stop button when streaming", () => {
    render(<ChatInput onSend={vi.fn()} onStop={vi.fn()} isStreaming />);
    expect(
      screen.getByRole("button", { name: /stop generation/i }),
    ).toBeInTheDocument();
  });

  it("calls onStop when stop button clicked", async () => {
    const onStop = vi.fn();
    const user = userEvent.setup();
    render(<ChatInput onSend={vi.fn()} onStop={onStop} isStreaming />);

    await user.click(screen.getByRole("button", { name: /stop generation/i }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("is disabled when disabled prop is true", () => {
    render(<ChatInput onSend={vi.fn()} disabled />);
    const input = screen.getByRole("textbox");
    expect(input).toBeDisabled();
  });

  it("keeps typing enabled but explains why send is disabled", async () => {
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={vi.fn()}
        sendDisabled
        sendDisabledReason="Starting session..."
      />,
    );

    const input = screen.getByRole("textbox");
    await user.type(input, "hello");
    expect(input).toHaveValue("hello");

    const sendButton = screen.getByRole("button", {
      name: "Starting session...",
    });
    expect(sendButton).toBeDisabled();

    await user.hover(sendButton);
    expect(
      await screen.findByRole("tooltip", { name: "Starting session..." }),
    ).toBeInTheDocument();
  });

  it("clears input after sending", async () => {
    const user = userEvent.setup();
    render(<ChatInput onSend={vi.fn()} />);

    const input = screen.getByRole("textbox");
    await user.type(input, "hello");
    await user.keyboard("{Enter}");

    expect(input).toHaveValue("");
  });

  it("selecting a persona @mention creates a sticky assistant chip and removes the mention text", async () => {
    const user = userEvent.setup();
    render(<StatefulChatInput />);

    const input = screen.getByRole("textbox");
    await user.type(input, "@Rev");
    await user.click(screen.getByRole("option", { name: /reviewer/i }));

    expect(input).toHaveValue("");
    expect(screen.getByText("Reviewer")).toBeInTheDocument();
  });

  it("shows project files in @mention results and inserts the selected path", async () => {
    const user = userEvent.setup();
    mockSearchFilesForMentions.mockResolvedValue(PROJECT_FILE_MENTION_ENTRIES);

    renderProjectChatInput();

    expect(mockSearchFilesForMentions).not.toHaveBeenCalled();

    const input = screen.getByRole("textbox");
    await user.type(input, "@read");

    await waitFor(() => {
      expect(mockSearchFilesForMentions).toHaveBeenCalledWith({
        roots: ["/Users/wesb/dev/goose2"],
        query: "read",
        maxResults: 12,
      });
    });

    expect(await screen.findByText("Paths")).toBeInTheDocument();

    const fileOption = await screen.findByRole("option", {
      name: /readme\.md/i,
    });
    await user.click(fileOption);

    expect(input).toHaveValue("@/Users/wesb/dev/goose2/README.md ");
  });

  it("pressing Enter inserts the active path mention without sending", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    mockSearchFilesForMentions.mockResolvedValue(PROJECT_FILE_MENTION_ENTRIES);
    renderProjectChatInput(onSend);

    const input = screen.getByRole("textbox");
    await user.type(input, "@read");
    expect(
      await screen.findByRole("option", { name: /readme\.md/i }),
    ).toBeInTheDocument();

    await user.keyboard("{Enter}");

    expect(input).toHaveValue("@/Users/wesb/dev/goose2/README.md ");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("consumes Meta+Enter in the open mention menu instead of send-now", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const onSendNow = vi.fn();
    mockSearchFilesForMentions.mockResolvedValue(PROJECT_FILE_MENTION_ENTRIES);
    render(
      <ChatInput
        onSend={onSend}
        onSendNow={onSendNow}
        isStreaming
        selectedProjectId="project-1"
        availableProjects={[
          {
            id: "project-1",
            name: "goose2",
            workingDirs: ["/Users/wesb/dev/goose2"],
          },
        ]}
      />,
    );

    const input = screen.getByRole("textbox");
    await user.type(input, "@read");
    expect(
      await screen.findByRole("option", { name: /readme\.md/i }),
    ).toBeInTheDocument();

    const wasNotPrevented = fireEvent.keyDown(input, {
      key: "Enter",
      metaKey: true,
    });

    // The open menu owns Enter with any modifiers: the mention confirms and
    // the half-typed draft never reaches send-now (or queued send).
    expect(wasNotPrevented).toBe(false);
    expect(input).toHaveValue("@/Users/wesb/dev/goose2/README.md ");
    expect(onSendNow).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("consumes Shift+Enter in the open mention menu without a newline or send", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    mockSearchFilesForMentions.mockResolvedValue(PROJECT_FILE_MENTION_ENTRIES);
    renderProjectChatInput(onSend);

    const input = screen.getByRole("textbox");
    await user.type(input, "@read");
    expect(
      await screen.findByRole("option", { name: /readme\.md/i }),
    ).toBeInTheDocument();

    const wasNotPrevented = fireEvent.keyDown(input, {
      key: "Enter",
      shiftKey: true,
    });

    // preventDefault blocks the native newline; the mention confirms instead.
    expect(wasNotPrevented).toBe(false);
    expect(input).toHaveValue("@/Users/wesb/dev/goose2/README.md ");
    expect((input as HTMLTextAreaElement).value).not.toContain("\n");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("pressing Tab inserts the active file path mention", async () => {
    const user = userEvent.setup();
    mockSearchFilesForMentions.mockResolvedValue(PROJECT_FILE_MENTION_ENTRIES);
    renderProjectChatInput();

    const input = screen.getByRole("textbox");
    await user.type(input, "@read");
    expect(
      await screen.findByRole("option", { name: /readme\.md/i }),
    ).toBeInTheDocument();

    await user.keyboard("{Tab}");

    expect(input).toHaveValue("@/Users/wesb/dev/goose2/README.md ");
  });

  it("pressing Tab completes the active folder path without closing mentions", async () => {
    const user = userEvent.setup();
    mockSearchFilesForMentions.mockResolvedValue(PROJECT_FILE_MENTION_ENTRIES);
    renderProjectChatInput();

    const input = screen.getByRole("textbox");
    await user.type(input, "@src");
    expect(
      await screen.findByRole("option", { name: /^src/i }),
    ).toBeInTheDocument();

    await user.keyboard("{Tab}");

    expect(input).toHaveValue("@/Users/wesb/dev/goose2/src/");
    await waitFor(() => {
      expect(mockSearchFilesForMentions).toHaveBeenCalledWith({
        roots: ["/Users/wesb/dev/goose2"],
        query: "/Users/wesb/dev/goose2/src/",
        maxResults: 12,
      });
    });
    expect(
      await screen.findByRole("option", { name: /chatinput\.tsx/i }),
    ).toBeInTheDocument();
  });

  it("keeps path mentions open when typing after a long project root completion", async () => {
    const user = userEvent.setup();
    const projectRoot = "/Users/wesb/Development/squareup/goose-internal";
    mockSearchFilesForMentions.mockImplementation(async ({ query }) =>
      query === `${projectRoot}/src`
        ? [
            {
              resolvedPath: `${projectRoot}/src/features`,
              displayPath: `${projectRoot}/src/features`,
              filename: "features",
              kind: "folder",
              source: "filesystem",
            },
          ]
        : [],
    );
    renderLongPathProjectChatInput();

    const input = screen.getByRole("textbox");
    await user.type(input, "@");
    expect(
      await screen.findByRole("option", {
        name: /goose-internal project root/i,
      }),
    ).toBeInTheDocument();

    await user.keyboard("{Tab}");
    expect(input).toHaveValue(`@${projectRoot}/`);

    await user.type(input, "src");

    await waitFor(() => {
      expect(mockSearchFilesForMentions).toHaveBeenCalledWith({
        roots: [projectRoot],
        query: `${projectRoot}/src`,
        maxResults: 12,
      });
    });
    expect(
      await screen.findByRole("option", { name: /features/i }),
    ).toBeInTheDocument();
  });

  it("pressing Escape closes path mentions without changing text", async () => {
    const user = userEvent.setup();
    mockSearchFilesForMentions.mockResolvedValue(PROJECT_FILE_MENTION_ENTRIES);
    renderProjectChatInput();

    const input = screen.getByRole("textbox");
    await user.type(input, "@read");
    expect(
      await screen.findByRole("option", { name: /readme\.md/i }),
    ).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(input).toHaveValue("@read");
    expect(
      screen.queryByRole("option", { name: /readme\.md/i }),
    ).not.toBeInTheDocument();
  });

  it("inserts folder and static root references as @path tokens", async () => {
    const user = userEvent.setup();
    mockSearchFilesForMentions.mockResolvedValue(PROJECT_FILE_MENTION_ENTRIES);
    renderProjectChatInput();

    const input = screen.getByRole("textbox");
    await user.type(input, "@src");
    const folderOptions = await screen.findAllByRole("option", {
      name: /src/i,
    });
    await user.click(folderOptions[0]);
    expect(input).toHaveValue("@/Users/wesb/dev/goose2/src ");

    await user.clear(input);
    await user.type(input, "@goose2");
    await user.click(await screen.findByRole("option", { name: /^goose2/i }));
    expect(input).toHaveValue("@/Users/wesb/dev/goose2 ");
  });

  it("shows static path shortcuts on empty @ without searching project files", async () => {
    const user = userEvent.setup();
    renderProjectChatInput();

    const input = screen.getByRole("textbox");
    await user.type(input, "@");

    expect(await screen.findByText("Paths")).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /goose2 project root/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /home folder/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /filesystem root/i }),
    ).not.toBeInTheDocument();
    expect(mockSearchFilesForMentions).not.toHaveBeenCalled();

    await user.type(input, "/");
    expect(
      await screen.findByRole("option", { name: /filesystem root/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Home folder")).not.toBeInTheDocument();
    expect(mockSearchFilesForMentions).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, "@~");
    expect(
      await screen.findByRole("option", { name: /home folder/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Filesystem root")).not.toBeInTheDocument();
    expect(mockSearchFilesForMentions).not.toHaveBeenCalled();
  });

  it("does not search project files for single-character plain queries", async () => {
    const user = userEvent.setup();
    renderProjectChatInput();

    await user.type(screen.getByRole("textbox"), "@r");

    expect(screen.queryByText("Paths")).not.toBeInTheDocument();
    expect(mockSearchFilesForMentions).not.toHaveBeenCalled();
  });

  it("searches typed absolute path prefixes without a selected project", async () => {
    const user = userEvent.setup();
    mockSearchFilesForMentions.mockResolvedValue([
      {
        resolvedPath: "/tmp/zsh-fzf-tab-kalvin",
        displayPath: "/tmp/zsh-fzf-tab-kalvin",
        filename: "zsh-fzf-tab-kalvin",
        kind: "folder",
        source: "filesystem",
      },
    ]);
    render(<ChatInput onSend={vi.fn()} />);

    const input = screen.getByRole("textbox");
    await user.type(input, "@/tmp/zs");

    await waitFor(() => {
      expect(mockSearchFilesForMentions).toHaveBeenCalledWith({
        roots: [],
        query: "/tmp/zs",
        maxResults: 12,
      });
    });

    await user.click(
      await screen.findByRole("option", { name: /zsh-fzf-tab-kalvin/i }),
    );

    expect(input).toHaveValue("@/tmp/zsh-fzf-tab-kalvin ");
  });

  it("keeps long project-relative path mentions searchable past the text mention cap", async () => {
    const user = userEvent.setup();
    const query =
      "src/features/chat/ui/very/long/path/with/more/segments/file.ts";
    renderProjectChatInput();

    await user.type(screen.getByRole("textbox"), `@${query}`);

    await waitFor(() => {
      expect(mockSearchFilesForMentions).toHaveBeenCalledWith({
        roots: ["/Users/wesb/dev/goose2"],
        query,
        maxResults: 12,
      });
    });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("keeps absolute path mentions open when the path contains spaces", async () => {
    const user = userEvent.setup();
    mockSearchFilesForMentions.mockResolvedValue([
      {
        resolvedPath: "/Users/wesb/My Project/src",
        displayPath: "/Users/wesb/My Project/src",
        filename: "src",
        kind: "folder",
        source: "filesystem",
      },
    ]);
    render(<ChatInput onSend={vi.fn()} />);

    const input = screen.getByRole("textbox");
    await user.type(input, "@/Users/wesb/My Project/");
    await user.type(input, "src");

    await waitFor(() => {
      expect(mockSearchFilesForMentions).toHaveBeenCalledWith({
        roots: [],
        query: "/Users/wesb/My Project/src",
        maxResults: 12,
      });
    });
    expect(
      await screen.findByRole("option", { name: /^src/i }),
    ).toBeInTheDocument();
  });

  it("prevents Enter from sending a partial path mention while paths are loading", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    mockSearchFilesForMentions.mockReturnValue(new Promise(() => {}));
    renderProjectChatInput(onSend);

    const input = screen.getByRole("textbox");
    await user.type(input, "@read");
    await waitFor(() => {
      expect(mockSearchFilesForMentions).toHaveBeenCalledWith({
        roots: ["/Users/wesb/dev/goose2"],
        query: "read",
        maxResults: 12,
      });
    });

    const wasNotPrevented = fireEvent.keyDown(input, { key: "Enter" });

    expect(wasNotPrevented).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue("@read");
  });

  it("lets Shift+Tab use native focus behavior instead of completing folders", async () => {
    const user = userEvent.setup();
    mockSearchFilesForMentions.mockResolvedValue(PROJECT_FILE_MENTION_ENTRIES);
    renderProjectChatInput();

    const input = screen.getByRole("textbox");
    await user.type(input, "@src");
    expect(
      await screen.findByRole("option", { name: /^src/i }),
    ).toBeInTheDocument();

    const wasNotPrevented = fireEvent.keyDown(input, {
      key: "Tab",
      shiftKey: true,
    });

    expect(wasNotPrevented).toBe(true);
    expect(input).toHaveValue("@src");
  });

  it("ranks concrete home path results ahead of the Home shortcut for longer queries", async () => {
    const user = userEvent.setup();
    mockSearchFilesForMentions.mockResolvedValue([
      {
        resolvedPath: "/Users/wesb/Downloads",
        displayPath: "~/Downloads",
        filename: "Downloads",
        kind: "folder",
        source: "filesystem",
      },
    ]);
    render(<ChatInput onSend={vi.fn()} />);

    const input = screen.getByRole("textbox");
    await user.type(input, "@~/Dow");
    expect(
      await screen.findByRole("option", { name: /^downloads/i }),
    ).toBeInTheDocument();

    await user.keyboard("{Enter}");

    expect(input).toHaveValue("@/Users/wesb/Downloads ");
  });

  it("does not match static shortcut labels for plain text file mentions", async () => {
    const user = userEvent.setup();
    renderProjectChatInput();

    const input = screen.getByRole("textbox");
    await user.type(input, "@pro");

    expect(
      screen.queryByRole("option", { name: /project root/i }),
    ).not.toBeInTheDocument();
  });

  it("does not match absolute path prefixes for plain text file mentions", async () => {
    const user = userEvent.setup();
    renderProjectChatInput();

    const input = screen.getByRole("textbox");
    await user.type(input, "@users");

    expect(
      screen.queryByRole("option", { name: /project root/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /home folder/i }),
    ).not.toBeInTheDocument();
  });

  it("closes dotted plain mentions when the user types a space", async () => {
    const user = userEvent.setup();
    renderProjectChatInput();

    const input = screen.getByRole("textbox");
    await user.type(input, "@v2.0");
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    await user.type(input, " release notes");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("does not debounce-search single-character plain mentions", async () => {
    vi.useFakeTimers();
    try {
      renderProjectChatInput();

      const input = screen.getByRole("textbox");
      fireEvent.change(input, {
        target: { value: "@r", selectionStart: 2 },
      });
      await vi.advanceTimersByTimeAsync(100);

      expect(mockSearchFilesForMentions).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps compatible previous path rows visible while the next search is pending", async () => {
    const user = userEvent.setup();
    const nextSearch = deferred<unknown[]>();
    mockSearchFilesForMentions.mockImplementation(({ query }) => {
      if (query === "read") {
        return Promise.resolve([PROJECT_FILE_MENTION_ENTRIES[0]]);
      }
      if (query === "readm") {
        return nextSearch.promise;
      }
      return Promise.resolve([]);
    });
    renderProjectChatInput();

    const input = screen.getByRole("textbox");
    await user.type(input, "@read");
    expect(
      await screen.findByRole("option", { name: /readme\.md/i }),
    ).toBeInTheDocument();

    await user.type(input, "m");
    await waitFor(() => {
      expect(mockSearchFilesForMentions).toHaveBeenCalledWith({
        roots: ["/Users/wesb/dev/goose2"],
        query: "readm",
        maxResults: 12,
      });
    });

    expect(
      screen.getByRole("option", { name: /readme\.md/i }),
    ).toBeInTheDocument();

    nextSearch.resolve([PROJECT_FILE_MENTION_ENTRIES[0]]);
    await waitFor(() => {
      expect(screen.queryByText("Loading paths...")).not.toBeInTheDocument();
    });
  });

  it("clamps the active path selection when async results shrink", async () => {
    const user = userEvent.setup();
    Element.prototype.scrollIntoView = vi.fn();
    const readme = PROJECT_FILE_MENTION_ENTRIES[0];
    mockSearchFilesForMentions.mockImplementation(({ query }) => {
      if (query === "read") {
        return Promise.resolve([
          readme,
          {
            resolvedPath: "/Users/wesb/dev/goose2/reader.md",
            displayPath: "goose2/reader.md",
            filename: "reader.md",
            kind: "file",
            source: "project",
          },
          {
            resolvedPath: "/Users/wesb/dev/goose2/read-later.md",
            displayPath: "goose2/read-later.md",
            filename: "read-later.md",
            kind: "file",
            source: "project",
          },
        ]);
      }
      if (query === "readm") {
        return Promise.resolve([readme]);
      }
      return Promise.resolve([]);
    });
    renderProjectChatInput();

    const input = screen.getByRole("textbox");
    await user.type(input, "@read");
    expect(
      await screen.findByRole("option", { name: /reader\.md/i }),
    ).toBeInTheDocument();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: /reader\.md/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.type(input, "m");
    await waitFor(() => {
      expect(screen.queryByText("reader.md")).not.toBeInTheDocument();
    });

    await user.keyboard("{Enter}");

    expect(input).toHaveValue("@/Users/wesb/dev/goose2/README.md ");
  });

  it("uses textarea-safe aria with live mention status and stable listbox options", async () => {
    const user = userEvent.setup();
    renderProjectChatInput();

    const input = screen.getByRole("textbox");
    await user.type(input, "@");

    expect(input).not.toHaveAttribute("aria-expanded");
    expect(input).not.toHaveAttribute("aria-autocomplete");
    expect(input).not.toHaveAttribute("aria-activedescendant");
    expect(input).toHaveAttribute("aria-controls");
    expect(input).toHaveAttribute("aria-describedby");

    const statusId = input.getAttribute("aria-describedby");
    expect(statusId).toBeTruthy();
    const status = document.getElementById(statusId as string);
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("2 references available");

    const listbox = screen.getByRole("listbox", {
      name: "Reference suggestions",
    });
    const options = within(listbox).getAllByRole("option");
    expect(options[0]).toHaveAttribute(
      "id",
      `${input.getAttribute("aria-controls")}-option-0`,
    );
    expect(options[0]).toHaveAttribute("aria-selected", "true");
  });

  // ---------------------------------------------------------------------------
  // Message queue & streaming behavior
  // ---------------------------------------------------------------------------

  it("textarea is enabled during streaming", () => {
    render(<ChatInput onSend={vi.fn()} isStreaming />);
    expect(screen.getByRole("textbox")).not.toBeDisabled();
  });

  it("hides the native scrollbar for long composer drafts", () => {
    render(<ChatInput onSend={vi.fn()} />);

    const input = screen.getByRole("textbox");

    expect(input).toHaveClass("scrollbar-none", "overscroll-contain");
    expect(input).not.toHaveClass("scrollbar-subtle");
  });

  it("shows send button instead of stop when streaming with text entered", async () => {
    const user = userEvent.setup();
    render(<ChatInput onSend={vi.fn()} onStop={vi.fn()} isStreaming />);

    await user.type(screen.getByRole("textbox"), "follow up");

    expect(
      screen.getByRole("button", { name: /send message/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /stop generation/i }),
    ).not.toBeInTheDocument();
  });

  it("calls onSend during streaming when text is entered", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<ChatInput onSend={onSend} isStreaming />);

    await user.type(screen.getByRole("textbox"), "follow up");
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith("follow up", undefined, undefined);
  });

  it("queues on plain enter during streaming even when send-now is available", async () => {
    const onSend = vi.fn();
    const onSendNow = vi.fn();
    const user = userEvent.setup();
    render(<ChatInput onSend={onSend} onSendNow={onSendNow} isStreaming />);

    await user.type(screen.getByRole("textbox"), "follow up");
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith("follow up", undefined, undefined);
    expect(onSendNow).not.toHaveBeenCalled();
  });

  it("sends queued message now from the queue bar", async () => {
    const onSendQueuedNow = vi.fn();
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={vi.fn()}
        onSendQueuedNow={onSendQueuedNow}
        onStop={vi.fn()}
        isStreaming
        queuedMessage={{ text: "queued msg" }}
      />,
    );

    await user.click(screen.getByRole("button", { name: /send now/i }));

    expect(onSendQueuedNow).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("button", { name: /stop generation/i }),
    ).not.toBeInTheDocument();
  });

  it("cmd-enter sends immediately while busy", async () => {
    const onSendNow = vi.fn();
    const user = userEvent.setup();
    render(<ChatInput onSend={vi.fn()} onSendNow={onSendNow} isStreaming />);

    await user.type(screen.getByRole("textbox"), "replacement");
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(onSendNow).toHaveBeenCalledWith("replacement", undefined, undefined);
  });

  it("does not send when queue is full", async () => {
    const onSend = vi.fn();
    const onSendNow = vi.fn();
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={onSend}
        onSendNow={onSendNow}
        isStreaming
        queuedMessage={{ text: "queued msg" }}
      />,
    );

    await user.type(screen.getByRole("textbox"), "another message");
    await user.keyboard("{Enter}");

    expect(onSend).not.toHaveBeenCalled();
    expect(onSendNow).not.toHaveBeenCalled();
  });

  it("does not stop dictation when send is blocked", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    mockVoiceDictation.isRecording = true;

    render(
      <ChatInput
        onSend={onSend}
        isStreaming
        queuedMessage={{ text: "queued msg" }}
      />,
    );

    await user.type(screen.getByRole("textbox"), "another message");
    await user.keyboard("{Enter}");

    expect(onSend).not.toHaveBeenCalled();
    expect(mockVoiceDictation.stopRecording).not.toHaveBeenCalled();
  });

  it("keeps the mic toggle enabled while recording even if voice input becomes unavailable", () => {
    render(
      <ChatInputToolbar
        agentModelPicker={{
          providers: [],
          selectedProvider: "goose",
          onProviderChange: vi.fn(),
          availableModels: [],
        }}
        projectPicker={{
          selectedProjectId: null,
          availableProjects: [],
        }}
        contextUsage={{
          contextTokens: 0,
          contextLimit: 0,
        }}
        composerActions={{
          canSend: false,
          isStreaming: false,
          hasQueuedMessage: false,
          onSend: vi.fn(),
          voiceEnabled: false,
          voiceRecording: true,
          onVoiceToggle: vi.fn(),
        }}
        isCompact={false}
      />,
    );

    expect(screen.getByRole("button", { name: "Listening..." })).toBeEnabled();
  });

  it("keeps the selected assistant chip after sending subsequent messages", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<StatefulChatInput onSend={onSend} />);

    const input = screen.getByRole("textbox");
    await user.type(input, "@Rev");
    await user.click(screen.getByRole("option", { name: /reviewer/i }));
    await user.click(input);
    await user.keyboard("{End}");
    await user.type(input, "hello");
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith("hello", "reviewer", undefined);
    expect(screen.getByText("Reviewer")).toBeInTheDocument();
  });

  it("recalls the last user message from an empty composer", () => {
    const onRecall = vi.fn(() => "my previous message");
    render(<ChatInput onSend={vi.fn()} onRecallLastUserMessage={onRecall} />);

    pressRecallArrowUp();

    expect(onRecall).toHaveBeenCalledTimes(1);
    expect(recallTextbox()).toHaveValue("my previous message");
    expect(recallTextbox().selectionStart).toBe("my previous message".length);
    expect(recallTextbox().selectionEnd).toBe("my previous message".length);
  });

  it("edits a queued message before recalling history", () => {
    const onDismissQueue = vi.fn();
    const onPersonaChange = vi.fn();
    const { onRecallLastUserMessage } = renderQueuedRecallInput({
      onDismissQueue,
      onPersonaChange,
      queuedMessage: {
        text: "queued follow up",
        personaId: "persona-1",
        attachments: [
          {
            id: "file-1",
            kind: "file" as const,
            name: "notes.txt",
            path: "/tmp/notes.txt",
          },
        ],
      },
    });

    pressRecallArrowUp();

    expect(onDismissQueue).toHaveBeenCalledTimes(1);
    expect(onRecallLastUserMessage).not.toHaveBeenCalled();
    expect(onPersonaChange).toHaveBeenCalledWith("persona-1");
    expect(recallTextbox()).toHaveValue("queued follow up");
    expect(recallTextbox().selectionStart).toBe("queued follow up".length);
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
  });

  it.each(["draft text", "\n  "])("leaves draft text alone", (draft) => {
    const callbacks = renderQueuedRecallInput();

    fireEvent.change(recallTextbox(), { target: { value: draft } });
    pressRecallArrowUp();

    expectNoRecallShortcutAction(callbacks);
    expect(recallTextbox()).toHaveValue(draft);
  });

  it("leaves staged attachments and skills alone", async () => {
    const onSkillsChange = vi.fn();
    const callbacks = renderQueuedRecallInput({
      selectedSkills: [{ id: "code-review", name: "code-review" }],
      onSkillsChange,
    });

    await stageRecallAttachment();
    pressRecallArrowUp();

    expectNoRecallShortcutAction(callbacks);
    expect(onSkillsChange).not.toHaveBeenCalled();
    expect(screen.getByText("draft.txt")).toBeInTheDocument();
    expect(screen.getByText("code-review")).toBeInTheDocument();
    expect(recallTextbox()).toHaveValue("");
  });

  it("keeps native modified and IME ArrowUp behavior", () => {
    const onRecall = vi.fn(() => "recalled");
    render(<ChatInput onSend={vi.fn()} onRecallLastUserMessage={onRecall} />);

    pressRecallArrowUp({ metaKey: true });
    pressRecallArrowUp({ isComposing: true });
    pressRecallArrowUp({ keyCode: 229 });

    expect(onRecall).not.toHaveBeenCalled();
    expect(recallTextbox()).toHaveValue("");
  });

  // -------------------------------------------------------------------------
  // User-configured shortcut overrides (goose:keyboard-shortcuts:v1)
  // -------------------------------------------------------------------------

  function setShortcutOverrides(overrides: Record<string, string>) {
    localStorage.setItem(
      "goose:keyboard-shortcuts:v1",
      JSON.stringify({ version: 1, overrides }),
    );
  }

  it("recalls with a rebound combo and releases plain ArrowUp", () => {
    setShortcutOverrides({ "chat.recallLastMessage": "alt+arrowup" });
    const onRecall = vi.fn(() => "my previous message");
    render(<ChatInput onSend={vi.fn()} onRecallLastUserMessage={onRecall} />);

    pressRecallArrowUp();
    expect(onRecall).not.toHaveBeenCalled();
    expect(recallTextbox()).toHaveValue("");

    pressRecallArrowUp({ altKey: true });
    expect(onRecall).toHaveBeenCalledTimes(1);
    expect(recallTextbox()).toHaveValue("my previous message");
  });

  it("sends with a rebound combo and releases plain Enter", async () => {
    setShortcutOverrides({ "chat.sendMessage": "alt+enter" });
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<ChatInput onSend={onSend} />);

    const input = screen.getByRole("textbox");
    await user.type(input, "hello");

    const plainEnterNotPrevented = fireEvent.keyDown(input, { key: "Enter" });
    expect(plainEnterNotPrevented).toBe(true);
    expect(onSend).not.toHaveBeenCalled();

    await user.keyboard("{Alt>}{Enter}{/Alt}");
    expect(onSend).toHaveBeenCalledWith("hello", undefined, undefined);
  });

  it("ignores a stored override that conflicts with another command default", async () => {
    // mod+enter is chat.sendNow's default; the registry drops the override
    // on read, so plain Enter keeps sending.
    setShortcutOverrides({ "chat.sendMessage": "meta+enter" });
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<ChatInput onSend={onSend} />);

    await user.type(screen.getByRole("textbox"), "hello");
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith("hello", undefined, undefined);
  });
});
