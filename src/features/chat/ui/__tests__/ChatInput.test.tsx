import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  act,
  cleanup,
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
import type { ChatInputComposerActions } from "../../types";
import { STREAMING_SHORTCUT_MODE_STORAGE_KEY } from "../../lib/streamingShortcutPreference";
import { MAX_PROMPT_ATTACHMENT_BYTES } from "../../lib/attachmentPayloadBudget";
import {
  resetShortcutOverride,
  setShortcutOverride,
} from "@/features/shortcuts/lib/shortcutRegistry";
import { resetVoiceDictationShortcutControllerForTests } from "../../lib/voiceDictationShortcutController";

const mockVoiceDictation = {
  isEnabled: true,
  isRecording: false,
  isTranscribing: false,
  isStarting: vi.fn(() => false),
  stopRecording: vi.fn(),
  toggleRecording: vi.fn(),
};
let lastVoiceAutoSubmit: ((text: string) => boolean | Promise<boolean>) | null =
  null;

vi.mock("../../hooks/useVoiceDictation", () => ({
  useAnyVoiceDictationActive: () => false,
  useVoiceDictation: (options: {
    onAutoSubmit?: (text: string) => boolean | Promise<boolean>;
  }) => {
    lastVoiceAutoSubmit = options.onAutoSubmit ?? null;
    return mockVoiceDictation;
  },
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

function immediatelyResolved<T>(value: T): Promise<T> {
  return {
    // biome-ignore lint/suspicious/noThenProperty: this test helper intentionally resolves synchronously.
    then(onfulfilled) {
      return Promise.resolve(onfulfilled?.(value));
    },
  } as Promise<T>;
}

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
  getHomeDir: vi.fn(() => immediatelyResolved("/Users/wesb")),
  searchFilesForMentions: (input: {
    roots: string[];
    query: string;
    maxResults?: number;
  }) => mockSearchFilesForMentions(input),
  inspectAttachmentPaths: (paths: string[]) =>
    mockInspectAttachmentPaths(paths),
  readImageAttachment: (path: string) => mockReadImageAttachment(path),
}));

vi.mock("@/features/skills/api/skills", () => ({
  listSkills: vi.fn(() => immediatelyResolved([])),
}));

vi.mock("@/features/skills/api/skillsQuery", () => ({
  fetchSkillsList: vi.fn(() => immediatelyResolved([])),
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
  onSend?: (
    text: string,
    personaId?: string | null,
  ) => boolean | Promise<boolean>;
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
          name: "berd",
          workingDirs: ["/Users/wesb/Development/squareup/berd"],
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

function basename(path: string) {
  return (
    path
      .split(/[\\/]+/)
      .filter(Boolean)
      .at(-1) ?? path
  );
}

function recallTextbox(): HTMLTextAreaElement {
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

function setViewportHeight(height: number) {
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    writable: true,
    value: height,
  });
}

function setTextareaScrollHeight(
  textarea: HTMLTextAreaElement,
  scrollHeight: number,
) {
  Object.defineProperty(textarea, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
}

const DEFAULT_VIEWPORT_HEIGHT = window.innerHeight;

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
      queuedMessage={{ persona: { kind: "none" }, text: "queued follow up" }}
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
  it("hides queued-message mutation controls without a dismiss handler", () => {
    render(
      <ChatInput
        onSend={vi.fn()}
        queuedMessage={{ persona: { kind: "none" }, text: "queued follow up" }}
      />,
    );

    expect(screen.getByText("queued follow up")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit queued message" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Dismiss queued message" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the composer piggyback at the top with queued messages below it", () => {
    render(
      <ChatInput
        surface="bare"
        innerBareSurface
        onSend={vi.fn()}
        queuedMessage={{ persona: { kind: "none" }, text: "queued follow up" }}
        onDismissQueue={vi.fn()}
        queuedMessageAccessory={<div>Configure a new worktree?</div>}
      />,
    );

    const queue = screen.getByText("queued follow up");
    const accessory = screen.getByText("Configure a new worktree?");
    expect(
      queue.parentElement?.parentElement?.parentElement?.parentElement,
    ).toHaveClass("-mx-1");
    expect(queue.parentElement).toHaveClass("flex", "items-center", "gap-2");
    expect(queue.parentElement?.parentElement).toHaveClass(
      "flex",
      "flex-col",
      "gap-1.5",
      "p-1.5",
    );
    expect(queue.parentElement?.parentElement?.parentElement).toHaveClass(
      "rounded-full",
      "bg-surface-chat-responding-pill-bg",
      "text-surface-chat-responding-pill-fg",
      "shadow-[var(--shadow-chat)]",
    );
    expect(queue).toHaveClass("pl-1.5", "text-sm");
    expect(accessory.parentElement).toHaveClass(
      "relative",
      "z-0",
      "-mb-2",
      "rounded-t-sm",
      "bg-surface-composer-action",
      "pb-2",
    );
    expect(accessory.parentElement).toHaveAttribute(
      "data-slot",
      "queued-message-accessory",
    );
    const composerShell = screen
      .getByTestId("chat-composer")
      .closest(".chat-composer-shell");
    expect(composerShell).toHaveClass(
      "z-10",
      "rounded-sm",
      "bg-surface-chat-composer",
      "[backdrop-filter:var(--backdrop-composer-glass)]",
    );
    expect(composerShell?.parentElement).not.toHaveClass(
      "bg-surface-chat-composer",
    );
    expect(accessory.parentElement?.nextElementSibling).toBe(composerShell);
    expect(composerShell?.contains(queue.parentElement)).toBe(true);
    expect(
      accessory.compareDocumentPosition(queue) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  afterEach(cleanup);

  beforeEach(() => {
    resetVoiceDictationShortcutControllerForTests();
    resetShortcutOverride("chat.toggleVoiceDictation");
    setViewportHeight(DEFAULT_VIEWPORT_HEIGHT);
    localStorage.clear();
    mockSearchFilesForMentions.mockClear();
    mockSearchFilesForMentions.mockResolvedValue([]);
    mockInspectAttachmentPaths.mockClear();
    mockInspectAttachmentPaths.mockImplementation(async (paths) =>
      paths.map((path) => ({
        name: basename(path),
        path,
        kind: /\.[^\\/]+$/.test(path) ? "file" : "directory",
      })),
    );
    mockReadImageAttachment.mockClear();
    mockReadImageAttachment.mockResolvedValue({
      base64: "abc",
      mimeType: "image/png",
    });
    mockVoiceDictation.isEnabled = true;
    mockVoiceDictation.isRecording = false;
    mockVoiceDictation.isTranscribing = false;
    mockVoiceDictation.isStarting.mockReset();
    mockVoiceDictation.isStarting.mockReturnValue(false);
    mockVoiceDictation.stopRecording.mockReset();
    mockVoiceDictation.toggleRecording.mockReset();
    lastVoiceAutoSubmit = null;
  });

  it("renders with default placeholder", () => {
    render(<ChatInput onSend={vi.fn()} />);
    expect(
      screen.getByPlaceholderText(
        "Chat with Goose, @ for agents/files, or / for skills",
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

    expect(onSend).toHaveBeenCalledWith("hello", null, undefined);
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

  it("toggles voice dictation with the default platform composer shortcut without changing the draft", () => {
    const onSend = vi.fn();
    const onDraftChange = vi.fn();
    const onParentKeyDown = vi.fn();
    render(
      <form onKeyDown={onParentKeyDown}>
        <ChatInput
          onSend={onSend}
          onDraftChange={onDraftChange}
          initialValue="keep this draft"
        />
      </form>,
    );

    const input = screen.getByRole("textbox");
    const wasNotPrevented = fireEvent.keyDown(input, {
      key: "d",
      code: "KeyD",
      metaKey: true,
    });

    expect(wasNotPrevented).toBe(false);
    expect(mockVoiceDictation.toggleRecording).toHaveBeenCalledOnce();
    expect(onParentKeyDown).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("keep this draft");
  });

  it("focuses and toggles dictation once from a non-editable outside target without mutating the draft", () => {
    const onSend = vi.fn();
    const onDraftChange = vi.fn();
    render(
      <>
        <button type="button">Outside</button>
        <ChatInput
          onSend={onSend}
          onDraftChange={onDraftChange}
          initialValue="keep this draft"
        />
      </>,
    );

    const outside = screen.getByRole("button", { name: "Outside" });
    const input = screen.getByRole("textbox");
    input.getBoundingClientRect = () =>
      ({
        bottom: 40,
        height: 30,
        left: 10,
        right: 210,
        top: 10,
        width: 200,
        x: 10,
        y: 10,
        toJSON: () => ({}),
      }) as DOMRect;
    outside.focus();
    expect(outside).toHaveFocus();

    const wasNotPrevented = fireEvent.keyDown(outside, {
      key: "d",
      code: "KeyD",
      metaKey: true,
    });

    expect(wasNotPrevented).toBe(false);
    expect(input).toHaveFocus();
    expect(mockVoiceDictation.toggleRecording).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("keep this draft");
  });

  it("shows the platform-formatted dictation shortcut and updates it when rebound", async () => {
    const user = userEvent.setup();
    render(<ChatInput onSend={vi.fn()} />);

    await user.hover(screen.getByRole("button", { name: "Voice dictation" }));

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("Voice dictation⌘D");
    expect(
      within(tooltip)
        .getAllByText(/⌘|D/)
        .map((part) => part.tagName),
    ).toEqual(["KBD", "KBD"]);

    act(() => {
      expect(setShortcutOverride("chat.toggleVoiceDictation", "alt+d")).toEqual(
        { ok: true },
      );
    });

    await waitFor(() => {
      expect(tooltip).toHaveTextContent("Voice dictation⌥D");
    });
    expect(tooltip).not.toHaveTextContent("⌘");
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

  it.each([
    ["model", /choose agent and model/i],
    ["project", /select project/i],
  ])("returns focus to the composer when the %s picker closes", async (_, triggerName) => {
    const user = userEvent.setup();
    renderProjectChatInput();
    const composer = screen.getByRole("textbox");

    await user.click(screen.getByRole("button", { name: triggerName }));
    expect(composer).not.toHaveFocus();

    await user.keyboard("{Escape}");

    expect(composer).toHaveFocus();
  });

  it.each([
    ["model", /choose agent and model/i],
    ["project", /select project/i],
  ])("returns focus to the composer when the %s picker trigger closes it", async (_, triggerName) => {
    const user = userEvent.setup();
    renderProjectChatInput();
    const composer = screen.getByRole("textbox");
    const trigger = screen.getByRole("button", { name: triggerName });

    await user.click(trigger);
    await user.click(trigger);

    expect(composer).toHaveFocus();
  });

  it.each([
    ["model", /choose agent and model/i],
    ["project", /select project/i],
  ])("returns focus to the composer when clicking blank space outside the %s picker", async (_, triggerName) => {
    const user = userEvent.setup();
    renderProjectChatInput();
    const composer = screen.getByRole("textbox");
    const blankSpace = document.createElement("div");
    document.body.appendChild(blankSpace);

    await user.click(screen.getByRole("button", { name: triggerName }));
    await user.click(blankSpace);

    expect(composer).toHaveFocus();
  });

  it("preserves an interactive destination when closing a picker", async () => {
    const user = userEvent.setup();
    renderProjectChatInput();
    const destination = document.createElement("button");
    destination.type = "button";
    destination.textContent = "Outside action";
    document.body.appendChild(destination);

    await user.click(
      screen.getByRole("button", { name: /choose agent and model/i }),
    );
    await user.click(destination);

    expect(destination).toHaveFocus();
  });

  it("preserves a custom focusable destination when closing a picker", async () => {
    const user = userEvent.setup();
    renderProjectChatInput();
    const destination = document.createElement("div");
    destination.tabIndex = 0;
    document.body.appendChild(destination);

    await user.click(
      screen.getByRole("button", { name: /choose agent and model/i }),
    );
    await user.click(destination);

    expect(destination).toHaveFocus();
  });

  it("preserves project-creation focus when the picker hands off", async () => {
    const user = userEvent.setup();
    const projectDialog = document.createElement("button");
    document.body.appendChild(projectDialog);
    render(
      <ChatInput
        onSend={vi.fn()}
        enabled
        onCreateProject={() => projectDialog.focus()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /select project/i }));
    await user.click(screen.getByRole("menuitem", { name: /create project/i }));

    expect(projectDialog).toHaveFocus();
    expect(screen.getByRole("textbox")).not.toHaveFocus();
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
      screen.queryByRole("button", { name: /voice dictation/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).not.toHaveFocus();
  });

  it("focuses when autofocus is re-enabled", async () => {
    const { rerender } = render(
      <ChatInput onSend={vi.fn()} controls={{ autoFocus: false }} />,
    );
    const textbox = screen.getByRole("textbox");
    expect(textbox).not.toHaveFocus();

    rerender(<ChatInput onSend={vi.fn()} controls={{ autoFocus: true }} />);

    await waitFor(() => expect(textbox).toHaveFocus());
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
        detail: { section: "behavior" },
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

  it("shows the start voice conversation tooltip on hover", async () => {
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={vi.fn()}
        voiceConversation={{
          visible: true,
          state: "off",
          boundSessionId: null,
          active: false,
          microphoneMuted: false,
          onToggle: vi.fn(),
          onMicrophoneMuteToggle: vi.fn(),
        }}
      />,
    );

    await user.hover(
      screen.getByRole("button", { name: "Start voice conversation" }),
    );

    expect(
      await screen.findByRole("tooltip", {
        name: "Start voice conversation",
      }),
    ).toBeInTheDocument();
  });

  it("shows voice tooltips in the individual-chat composer", async () => {
    const user = userEvent.setup();
    render(
      <ChatInput
        surface="bare"
        onSend={vi.fn()}
        voiceConversation={{
          visible: true,
          state: "off",
          boundSessionId: null,
          active: false,
          microphoneMuted: false,
          onToggle: vi.fn(),
          onMicrophoneMuteToggle: vi.fn(),
        }}
      />,
    );

    const voiceConversationTrigger = screen.getByRole("button", {
      name: "Start voice conversation",
    });
    await user.hover(voiceConversationTrigger);
    expect(
      await screen.findByRole("tooltip", {
        name: "Start voice conversation",
      }),
    ).toBeInTheDocument();
    await user.unhover(voiceConversationTrigger);
    await waitFor(() => {
      expect(
        screen.queryByRole("tooltip", { name: "Start voice conversation" }),
      ).not.toBeInTheDocument();
    });

    const dictationTrigger = screen.getByRole("button", {
      name: "Voice dictation",
    });
    await user.hover(dictationTrigger);
    expect(
      await screen.findByRole("tooltip", { name: /voice dictation/i }),
    ).toBeInTheDocument();
  });

  it("shows the voice dictation tooltip on hover", async () => {
    const user = userEvent.setup();
    render(<ChatInput onSend={vi.fn()} />);

    const dictationButton = screen.getByRole("button", {
      name: /voice dictation/i,
    });
    await user.hover(dictationButton);

    expect(
      await screen.findByRole("tooltip", { name: /voice dictation/i }),
    ).toBeInTheDocument();
  });

  it("shows a distinct voice conversation control", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={vi.fn()}
        voiceConversation={{
          visible: true,
          state: "off",
          boundSessionId: null,
          active: false,
          microphoneMuted: false,
          onToggle,
          onMicrophoneMuteToggle: vi.fn(),
        }}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Start voice conversation" }),
    );
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(
      screen
        .getByRole("button", { name: "Start voice conversation" })
        .querySelector(".lucide-phone"),
    ).toBeInTheDocument();
  });

  it("shows a destructive hang-up control while voice is active", () => {
    render(
      <ChatInput
        onSend={vi.fn()}
        voiceConversation={{
          visible: true,
          state: "listening",
          boundSessionId: "session-1",
          active: true,
          microphoneMuted: false,
          onToggle: vi.fn(),
          onMicrophoneMuteToggle: vi.fn(),
        }}
      />,
    );

    const button = screen.getByRole("button", { name: "Hang up" });
    const mute = screen.getByRole("button", { name: "Mute microphone" });
    expect(
      mute.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(button).toHaveClass("bg-destructive", "text-destructive-foreground");
    expect(button.querySelector(".lucide-phone-off")).toBeInTheDocument();
  });

  it("shows a new-call control outside the owning session", async () => {
    const onToggle = vi.fn();
    render(
      <ChatInput
        onSend={vi.fn()}
        voiceConversation={{
          visible: true,
          state: "listening",
          boundSessionId: "session-1",
          active: true,
          ownsActiveConversation: false,
          microphoneMuted: false,
          onToggle,
          onMicrophoneMuteToggle: vi.fn(),
        }}
      />,
    );

    const start = screen.getByRole("button", {
      name: "Start voice conversation",
    });
    expect(start).not.toHaveClass("bg-destructive");
    expect(start.querySelector(".lucide-phone")).toBeInTheDocument();
    await userEvent.click(start);
    expect(onToggle).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("button", { name: "Mute microphone" }),
    ).not.toBeInTheDocument();
  });

  it("reports the muted microphone state on the voice conversation control", () => {
    render(
      <ChatInput
        onSend={vi.fn()}
        voiceConversation={{
          visible: true,
          state: "listening",
          boundSessionId: "session-1",
          active: true,
          microphoneMuted: true,
          onToggle: vi.fn(),
          onMicrophoneMuteToggle: vi.fn(),
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Hang up" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Unmute microphone" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen
        .getByRole("button", { name: "Unmute microphone" })
        .querySelector(".lucide-mic-off"),
    ).toBeInTheDocument();
  });

  it.each([
    "starting",
    "listening",
    "user-speaking",
    "agent-working",
    "agent-speaking",
  ] as const)("keeps the voice control active in the %s state", (state) => {
    render(
      <ChatInput
        onSend={vi.fn()}
        voiceConversation={{
          visible: true,
          state,
          boundSessionId: "session-1",
          active: true,
          microphoneMuted: false,
          onToggle: vi.fn(),
          onMicrophoneMuteToggle: vi.fn(),
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Hang up" })).toHaveClass(
      "bg-destructive",
      "text-destructive-foreground",
    );
  });

  it("keeps the hang-up icon while voice activity changes", () => {
    const { container } = render(
      <ChatInput
        onSend={vi.fn()}
        voiceConversation={{
          visible: true,
          state: "user-speaking",
          boundSessionId: "session-1",
          active: true,
          microphoneMuted: false,
          onToggle: vi.fn(),
          onMicrophoneMuteToggle: vi.fn(),
        }}
      />,
    );

    expect(container.querySelector(".lucide-phone-off")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mute microphone" })).toHaveClass(
      "bg-info",
      "animate-pulse",
    );
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

  it("selecting a persona @mention creates a sticky assistant chip and completes the mention text", async () => {
    const user = userEvent.setup();
    render(<StatefulChatInput />);

    const input = screen.getByRole("textbox");
    await user.type(input, "@Rev");
    await user.click(screen.getByRole("option", { name: /reviewer/i }));

    expect(input).toHaveValue("@Reviewer ");
    expect(screen.getByText("Reviewer")).toBeInTheDocument();
  });

  it("pressing Tab accepts the highlighted persona suggestion", async () => {
    const user = userEvent.setup();
    render(<StatefulChatInput />);

    const input = screen.getByRole("textbox");
    await user.type(input, "@Rev");
    expect(
      await screen.findByRole("option", { name: /reviewer/i }),
    ).toBeInTheDocument();

    await user.keyboard("{Tab}");

    expect(input).toHaveValue("@Reviewer ");
    expect(input).toHaveFocus();
    expect(screen.getByText("Reviewer")).toBeInTheDocument();
  });

  it("sends the selected sticky persona as one visible agent chip", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<StatefulChatInput onSend={onSend} />);

    const input = screen.getByRole("textbox");
    await user.type(input, "check this");
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith(
      "check this",
      "builtin-solo",
      undefined,
      {
        chips: [
          {
            id: "builtin-solo",
            label: "Solo",
            agentRole: "active",
            type: "agent",
          },
        ],
      },
    );
  });

  it("sends a single persona @mention as one visible agent chip", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<StatefulChatInput onSend={onSend} />);

    const input = screen.getByRole("textbox");
    await user.type(input, "@Rev");
    await user.click(screen.getByRole("option", { name: /reviewer/i }));
    await user.type(input, "check this");
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith(
      "@Reviewer check this",
      "reviewer",
      undefined,
      {
        chips: [
          {
            id: "reviewer",
            label: "Reviewer",
            agentRole: "active",
            type: "agent",
          },
        ],
      },
    );
  });

  it("replaces the active persona when another persona is mentioned", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<StatefulChatInput onSend={onSend} />);

    const input = screen.getByRole("textbox");
    await user.type(input, "@Rev");
    await user.click(screen.getByRole("option", { name: /reviewer/i }));
    await user.type(input, "@Sol");
    await user.click(screen.getByRole("option", { name: /solo/i }));

    expect(screen.queryByText("@Reviewer")).not.toBeInTheDocument();
    expect(screen.getByText("Solo")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(
        "Chat with Solo, @ for agents/files, or / for skills",
      ),
    ).toBeInTheDocument();

    await user.type(input, "compare these approaches");
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith(
      "@Solo compare these approaches",
      "builtin-solo",
      undefined,
      {
        chips: [
          {
            id: "builtin-solo",
            label: "Solo",
            agentRole: "active",
            type: "agent",
          },
        ],
      },
    );
  });

  it("switches @ mention tabs with left and right arrows", async () => {
    const user = userEvent.setup();
    renderProjectChatInput();

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

  it("opens the shared mention popover to skills for slash mentions", async () => {
    const user = userEvent.setup();
    renderProjectChatInput();

    const input = screen.getByRole("textbox");
    await user.type(input, "/");

    expect(screen.getByRole("tab", { name: "Agents" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Files" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Skills" })).toHaveAttribute(
      "data-state",
      "active",
    );
  });

  it("shows project files in @mention results and attaches the selected path", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    mockSearchFilesForMentions.mockResolvedValue(PROJECT_FILE_MENTION_ENTRIES);

    renderProjectChatInput(onSend);

    expect(mockSearchFilesForMentions).not.toHaveBeenCalled();

    const input = screen.getByRole("textbox");
    await user.type(input, "@@read");

    await waitFor(() => {
      expect(mockSearchFilesForMentions).toHaveBeenCalledWith({
        roots: ["/Users/wesb/dev/goose2"],
        query: "read",
        maxResults: 12,
      });
    });

    expect(await screen.findByText("Files")).toBeInTheDocument();

    const fileOption = await screen.findByRole("option", {
      name: /readme\.md/i,
    });
    await user.click(fileOption);

    expect(input).toHaveValue("");
    expect(await screen.findByText("README.md")).toBeInTheDocument();
    expect(mockInspectAttachmentPaths).toHaveBeenCalledWith([
      "/Users/wesb/dev/goose2/README.md",
    ]);

    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(onSend).toHaveBeenCalledWith(
      "",
      null,
      expect.arrayContaining([
        expect.objectContaining({
          kind: "file",
          name: "README.md",
          path: "/Users/wesb/dev/goose2/README.md",
        }),
      ]),
    );
  });

  it("pressing Enter attaches the active path mention without sending", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    mockSearchFilesForMentions.mockResolvedValue(PROJECT_FILE_MENTION_ENTRIES);
    const inspection =
      deferred<Awaited<ReturnType<typeof mockInspectAttachmentPaths>>>();
    mockInspectAttachmentPaths.mockReturnValue(inspection.promise);
    renderProjectChatInput(onSend);

    const input = screen.getByRole("textbox");
    await user.type(input, "check @@read");
    expect(
      await screen.findByRole("option", { name: /readme\.md/i }),
    ).toBeInTheDocument();

    await user.keyboard("{Enter}");
    expect(input).toHaveValue("check ");

    await user.keyboard("{Enter}");
    expect(onSend).not.toHaveBeenCalled();

    inspection.resolve([
      {
        name: "README.md",
        path: "/Users/wesb/dev/goose2/README.md",
        kind: "file",
      },
    ]);

    expect(await screen.findByText("README.md")).toBeInTheDocument();
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith(
      "check",
      null,
      expect.arrayContaining([
        expect.objectContaining({
          kind: "file",
          name: "README.md",
          path: "/Users/wesb/dev/goose2/README.md",
        }),
      ]),
    );
  });

  it("consumes Meta+Enter in the open mention menu instead of send-now", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    mockSearchFilesForMentions.mockResolvedValue(PROJECT_FILE_MENTION_ENTRIES);
    render(
      <ChatInput
        onSend={onSend}
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
    await user.type(input, "@@read");
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
    expect(input).toHaveValue("");
    expect(await screen.findByText("README.md")).toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("consumes Shift+Enter in the open mention menu without a newline or send", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    mockSearchFilesForMentions.mockResolvedValue(PROJECT_FILE_MENTION_ENTRIES);
    renderProjectChatInput(onSend);

    const input = screen.getByRole("textbox");
    await user.type(input, "@@read");
    expect(
      await screen.findByRole("option", { name: /readme\.md/i }),
    ).toBeInTheDocument();

    const wasNotPrevented = fireEvent.keyDown(input, {
      key: "Enter",
      shiftKey: true,
    });

    // preventDefault blocks the native newline; the mention confirms instead.
    expect(wasNotPrevented).toBe(false);
    expect(input).toHaveValue("");
    expect(await screen.findByText("README.md")).toBeInTheDocument();
    expect((input as HTMLTextAreaElement).value).not.toContain("\n");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("pressing Tab attaches the active file path mention", async () => {
    const user = userEvent.setup();
    mockSearchFilesForMentions.mockResolvedValue(PROJECT_FILE_MENTION_ENTRIES);
    renderProjectChatInput();

    const input = screen.getByRole("textbox");
    await user.type(input, "@@read");
    expect(
      await screen.findByRole("option", { name: /readme\.md/i }),
    ).toBeInTheDocument();

    await user.keyboard("{Tab}");

    expect(input).toHaveValue("");
    expect(await screen.findByText("README.md")).toBeInTheDocument();
  });

  it("pressing Tab completes the active folder path without closing mentions", async () => {
    const user = userEvent.setup();
    mockSearchFilesForMentions.mockResolvedValue(PROJECT_FILE_MENTION_ENTRIES);
    renderProjectChatInput();

    const input = screen.getByRole("textbox");
    await user.type(input, "@@src");
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
    const projectRoot = "/Users/wesb/Development/squareup/berd";
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
    await user.type(input, "@@");
    expect(
      await screen.findByRole("option", {
        name: /berd project root/i,
      }),
    ).toBeInTheDocument();

    await user.keyboard("{Tab}");
    expect(input).toHaveValue(`@${projectRoot}/`);

    await user.keyboard("src");

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
    const windowKeyDown = vi.fn();
    window.addEventListener("keydown", windowKeyDown);
    mockSearchFilesForMentions.mockResolvedValue(PROJECT_FILE_MENTION_ENTRIES);
    try {
      renderProjectChatInput();

      const input = screen.getByRole("textbox");
      await user.type(input, "@@read");
      expect(
        await screen.findByRole("option", { name: /readme\.md/i }),
      ).toBeInTheDocument();
      windowKeyDown.mockClear();

      await user.keyboard("{Escape}");

      expect(input).toHaveValue("@read");
      expect(
        screen.queryByRole("option", { name: /readme\.md/i }),
      ).not.toBeInTheDocument();
      expect(windowKeyDown).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", windowKeyDown);
    }
  });

  it("dismisses mentions when the composer is clicked", async () => {
    const user = userEvent.setup();
    renderProjectChatInput();

    const input = screen.getByRole("textbox");
    await user.type(input, "@missing");
    expect(screen.getByRole("tab", { name: "Agents" })).not.toBeNull();

    await user.click(input);

    expect(screen.queryByRole("tab", { name: "Agents" })).toBeNull();
    expect((input as HTMLTextAreaElement).value).toBe("@missing");
  });

  it("keeps mentions dismissed while the current token is still being typed", async () => {
    const user = userEvent.setup();
    renderProjectChatInput();

    const input = screen.getByRole("textbox");
    await user.type(input, "@log");
    expect(screen.getByRole("tab", { name: "Agents" })).not.toBeNull();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tab", { name: "Agents" })).toBeNull();

    await user.type(input, "fold");

    expect((input as HTMLTextAreaElement).value).toBe("@logfold");
    expect(screen.queryByRole("tab", { name: "Agents" })).toBeNull();
  });

  it("opens mentions in a new draft after the previous token was dismissed", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    renderProjectChatInput(onSend);

    const input = screen.getByRole("textbox");
    await user.type(input, "@missing");
    expect(screen.getByRole("tab", { name: "Agents" })).not.toBeNull();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tab", { name: "Agents" })).toBeNull();

    await user.keyboard("{Enter}");
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(""));

    await user.type(input, "@");
    expect(screen.getByRole("tab", { name: "Agents" })).not.toBeNull();
  });

  it("attaches folder and static root references as chips", async () => {
    const user = userEvent.setup();
    mockSearchFilesForMentions.mockResolvedValue(PROJECT_FILE_MENTION_ENTRIES);
    renderProjectChatInput();

    const input = screen.getByRole("textbox");
    await user.type(input, "@@src");
    const folderOptions = await screen.findAllByRole("option", {
      name: /src/i,
    });
    await user.click(folderOptions[0]);
    expect(input).toHaveValue("");
    expect(await screen.findByText("src")).toBeInTheDocument();

    await user.type(input, "@@goose2");
    await user.click(await screen.findByRole("option", { name: /^goose2/i }));
    expect(input).toHaveValue("");
    expect((await screen.findAllByText("goose2")).length).toBeGreaterThan(0);
  });

  it("shows static path shortcuts on empty @ without searching project files", async () => {
    const user = userEvent.setup();
    renderProjectChatInput();

    const input = screen.getByRole("textbox");
    await user.type(input, "@@");

    expect(await screen.findByText("Files")).toBeInTheDocument();
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

    await user.keyboard("/");
    expect(
      await screen.findByRole("option", { name: /filesystem root/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Home folder")).not.toBeInTheDocument();
    expect(mockSearchFilesForMentions).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, "@@~");
    expect(
      await screen.findByRole("option", { name: /home folder/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Filesystem root")).not.toBeInTheDocument();
    expect(mockSearchFilesForMentions).not.toHaveBeenCalled();
  });

  it("uses explicit file mention roots when there is no selected project", async () => {
    const user = userEvent.setup();
    mockSearchFilesForMentions.mockResolvedValue([
      {
        resolvedPath: "/Users/wesb/Development/squareup/berd/sdk",
        displayPath: "berd/sdk",
        filename: "sdk",
        kind: "folder",
        source: "project",
      },
    ]);
    render(
      <ChatInput
        onSend={vi.fn()}
        skillProjectDirs={["/Users/wesb/Development/squareup/skills-only"]}
        fileMentionProjectDirs={["/Users/wesb/Development/squareup/berd"]}
      />,
    );

    const input = screen.getByRole("textbox");
    await user.type(input, "@@");

    expect(
      await screen.findByRole("option", {
        name: /berd project root/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /filesystem root/i }),
    ).not.toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "@@berd");

    await waitFor(() => {
      expect(mockSearchFilesForMentions).toHaveBeenCalledWith({
        roots: ["/Users/wesb/Development/squareup/berd"],
        query: "/Users/wesb/Development/squareup/berd",
        maxResults: 12,
      });
    });
    const rootQueryOptions = await screen.findAllByRole("option");
    expect(rootQueryOptions[0]).toHaveAccessibleName(/berd project root/i);
    expect(
      screen.getByRole("option", { name: /sdk berd\s*\/sdk/i }),
    ).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "@@berd/");

    await waitFor(() => {
      expect(mockSearchFilesForMentions).toHaveBeenCalledWith({
        roots: ["/Users/wesb/Development/squareup/berd"],
        query: "/Users/wesb/Development/squareup/berd/",
        maxResults: 12,
      });
    });
    expect(
      await screen.findByRole("option", {
        name: /berd project root/i,
      }),
    ).toBeInTheDocument();
  });

  it("scopes project-root-prefixed path searches to the named root", async () => {
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={vi.fn()}
        skillProjectDirs={["/workspace/skills-only"]}
        fileMentionProjectDirs={["/workspace/frontend", "/workspace/backend"]}
      />,
    );

    await user.type(screen.getByRole("textbox"), "@@frontend/src");

    await waitFor(() => {
      const srcCall = mockSearchFilesForMentions.mock.calls.find(
        ([input]) => input.query === "src",
      );
      expect(srcCall?.[0]).toEqual({
        roots: ["/workspace/frontend"],
        query: "src",
        maxResults: 12,
      });
    });
  });

  it("does not search project files for single-character plain queries", async () => {
    const user = userEvent.setup();
    renderProjectChatInput();

    await user.type(screen.getByRole("textbox"), "@@r");

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
    await user.type(input, "@@/tmp/zs");

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

    expect(input).toHaveValue("");
    expect(await screen.findByText("zsh-fzf-tab-kalvin")).toBeInTheDocument();
  });

  it("keeps long project-relative path mentions searchable past the text mention cap", async () => {
    const user = userEvent.setup();
    const query =
      "src/features/chat/ui/very/long/path/with/more/segments/file.ts";
    renderProjectChatInput();

    await user.type(screen.getByRole("textbox"), `@@${query}`);

    await waitFor(() => {
      expect(mockSearchFilesForMentions).toHaveBeenCalledWith({
        roots: ["/Users/wesb/dev/goose2"],
        query,
        maxResults: 12,
      });
    });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("searches project paths after a typed project folder prefix", async () => {
    const user = userEvent.setup();
    mockSearchFilesForMentions.mockResolvedValue(PROJECT_FILE_MENTION_ENTRIES);
    renderProjectChatInput();

    await user.type(screen.getByRole("textbox"), "@@goose2/read");

    await waitFor(() => {
      expect(mockSearchFilesForMentions).toHaveBeenCalledWith({
        roots: ["/Users/wesb/dev/goose2"],
        query: "read",
        maxResults: 12,
      });
    });
    expect(
      await screen.findByRole("option", { name: /readme\.md/i }),
    ).toBeInTheDocument();
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
    await user.type(input, "@@/Users/wesb/My Project/");
    await user.keyboard("src");

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
    await user.type(input, "@@read");
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
    await user.type(input, "@@src");
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
    await user.type(input, "@@~/Dow");
    expect(
      await screen.findByRole("option", { name: /^downloads/i }),
    ).toBeInTheDocument();

    await user.keyboard("{Enter}");

    expect(input).toHaveValue("");
    expect(await screen.findByText("Downloads")).toBeInTheDocument();
  });

  it("does not match static shortcut labels for plain text file mentions", async () => {
    const user = userEvent.setup();
    renderProjectChatInput();

    const input = screen.getByRole("textbox");
    await user.type(input, "@@pro");

    expect(
      screen.queryByRole("option", { name: /project root/i }),
    ).not.toBeInTheDocument();
  });

  it("does not match absolute path prefixes for plain text file mentions", async () => {
    const user = userEvent.setup();
    renderProjectChatInput();

    const input = screen.getByRole("textbox");
    await user.type(input, "@@users");

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
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

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
    await user.type(input, "@@read");
    expect(
      await screen.findByRole("option", { name: /readme\.md/i }),
    ).toBeInTheDocument();

    await user.keyboard("m");
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
    await user.type(input, "@@read");
    expect(
      await screen.findByRole("option", { name: /reader\.md/i }),
    ).toBeInTheDocument();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: /reader\.md/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.keyboard("m");
    await waitFor(() => {
      expect(screen.queryByText("reader.md")).not.toBeInTheDocument();
    });

    await user.keyboard("{Enter}");

    expect(input).toHaveValue("");
    expect(await screen.findByText("README.md")).toBeInTheDocument();
  });

  it("uses textarea-safe aria with live mention status and stable listbox options", async () => {
    const user = userEvent.setup();
    renderProjectChatInput();

    const input = screen.getByRole("textbox");
    await user.type(input, "@@");

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

  it("uses the shared subtle scrollbar for long composer drafts", () => {
    render(<ChatInput onSend={vi.fn()} />);

    const input = screen.getByRole("textbox");

    expect(input).toHaveClass(
      "overflow-y-auto",
      "scrollbar-subtle",
      "overscroll-contain",
    );
    expect(input).not.toHaveClass("scrollbar-none");
  });

  it("keeps the docked composer responsively bounded before content scrolls internally", () => {
    render(<ChatInput onSend={vi.fn()} surface="bare" />);

    expect(screen.getByRole("textbox")).toHaveClass(
      "max-h-[clamp(140px,24dvh,300px)]",
    );
  });

  it("caps docked textarea growth by viewport before internal scrolling", async () => {
    setViewportHeight(1400);
    render(<ChatInput onSend={vi.fn()} surface="bare" />);

    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    setTextareaScrollHeight(input, 400);
    fireEvent.change(input, { target: { value: "draft".repeat(100) } });

    await waitFor(() => expect(input.style.height).toBe("300px"));

    setViewportHeight(600);
    setTextareaScrollHeight(input, 400);
    fireEvent.change(input, { target: { value: "draft".repeat(101) } });

    await waitFor(() => expect(input.style.height).toBe("144px"));
  });

  it("keeps stop button available when streaming with text entered", async () => {
    const onStop = vi.fn();
    const user = userEvent.setup();
    render(<ChatInput onSend={vi.fn()} onStop={onStop} isStreaming />);

    const input = screen.getByRole("textbox");
    await user.type(input, "follow up");

    expect(
      screen.getByRole("button", { name: /stop generation/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /send message/i }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /stop generation/i }));

    expect(onStop).toHaveBeenCalledOnce();
    expect(input).toHaveValue("follow up");
  });

  it("keeps stop button available when streaming with draft context selected", () => {
    render(
      <ChatInput
        onSend={vi.fn()}
        onStop={vi.fn()}
        isStreaming
        selectedSkills={[{ id: "code-review", name: "code-review" }]}
      />,
    );

    expect(
      screen.getByRole("button", { name: /stop generation/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /send message/i }),
    ).not.toBeInTheDocument();
  });

  it("stops streaming with Escape without sending or clearing a draft", async () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    const user = userEvent.setup();
    render(<ChatInput onSend={onSend} onStop={onStop} isStreaming />);

    const input = screen.getByRole("textbox");
    await user.type(input, "follow up");
    await user.keyboard("{Escape}");

    expect(onStop).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue("follow up");
  });

  it("calls onSend during streaming when text is entered", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<ChatInput onSend={onSend} isStreaming />);

    await user.type(screen.getByRole("textbox"), "follow up");
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith("follow up", null, undefined);
  });

  it("queues on plain enter during streaming", async () => {
    const onSend = vi.fn();
    const onSteerMessage = vi.fn();
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={onSend}
        onSteerMessage={onSteerMessage}
        canSteerMessage
        isStreaming
      />,
    );

    await user.type(screen.getByRole("textbox"), "follow up");
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith("follow up", null, undefined);
    expect(onSteerMessage).not.toHaveBeenCalled();
  });

  it("steers on cmd-enter during streaming by default", async () => {
    const onSend = vi.fn();
    const onSteerMessage = vi.fn();
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={onSend}
        onSteerMessage={onSteerMessage}
        canSteerMessage
        isStreaming
      />,
    );

    await user.type(screen.getByRole("textbox"), "follow up");
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(onSteerMessage).toHaveBeenCalledWith(
      "follow up",
      undefined,
      undefined,
    );
    expect(onSend).not.toHaveBeenCalled();
  });

  it("steers queued message from the queue bar", async () => {
    const onSteerQueuedMessage = vi.fn();
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={vi.fn()}
        onSteerQueuedMessage={onSteerQueuedMessage}
        canSteerQueuedMessage
        onStop={vi.fn()}
        isStreaming
        queuedMessage={{ persona: { kind: "none" }, text: "queued msg" }}
      />,
    );

    expect(screen.getByRole("button", { name: /steer/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /steer/i }));

    expect(onSteerQueuedMessage).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: /stop generation/i }),
    ).toBeInTheDocument();
  });

  it("hides queue edit and dismiss actions when dismissal is disabled", () => {
    render(
      <ChatInput
        onSend={vi.fn()}
        queuedMessage={{ persona: { kind: "none" }, text: "queued msg" }}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Edit queued message" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Dismiss queued message" }),
    ).not.toBeInTheDocument();
  });

  it("hides queued-head steering while that record is being edited", async () => {
    const onSteerQueuedMessage = vi.fn();
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={vi.fn()}
        onSteerQueuedMessage={onSteerQueuedMessage}
        canSteerQueuedMessage
        isStreaming
        queuedMessages={[
          {
            recordId: "head",
            payload: { persona: { kind: "none" as const }, text: "queued msg" },
          },
        ]}
        onEditQueue={vi.fn(() => true)}
        onCancelQueueEdit={vi.fn(() => true)}
        onDismissQueue={vi.fn()}
        onUpdateQueue={vi.fn(() => true)}
      />,
    );

    expect(screen.getByTitle("Steer queued message")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );

    expect(screen.queryByTitle("Steer queued message")).not.toBeInTheDocument();
    expect(onSteerQueuedMessage).not.toHaveBeenCalled();
  });

  it("does not flash a newly queued message that sends during the visibility grace period", async () => {
    vi.useFakeTimers();
    try {
      const queueProps = {
        onEditQueue: vi.fn(() => true),
        onCancelQueueEdit: vi.fn(() => true),
        onDismissQueue: vi.fn(),
        onUpdateQueue: vi.fn(() => true),
      };
      const { rerender } = render(
        <ChatInput onSend={vi.fn()} queuedMessages={[]} {...queueProps} />,
      );

      rerender(
        <ChatInput
          onSend={vi.fn()}
          queuedMessages={[
            {
              recordId: "immediate-send",
              payload: { persona: { kind: "none" }, text: "send now" },
            },
          ]}
          {...queueProps}
        />,
      );
      expect(screen.queryByText("send now")).not.toBeInTheDocument();

      rerender(
        <ChatInput onSend={vi.fn()} queuedMessages={[]} {...queueProps} />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(screen.queryByText("send now")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an idle send hidden when its dispatch flips the session to streaming", async () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <ChatInput onSend={vi.fn()} queuedMessages={[]} />,
      );

      // The record enters the queue while idle, then dispatch starts the run
      // before the record is dismissed. Streaming must not upgrade a record
      // already in its grace period to immediate visibility.
      rerender(
        <ChatInput
          onSend={vi.fn()}
          queuedMessages={[
            {
              recordId: "dispatching",
              payload: { persona: { kind: "none" }, text: "on its way" },
            },
          ]}
        />,
      );
      rerender(
        <ChatInput
          onSend={vi.fn()}
          isStreaming
          queuedMessages={[
            {
              recordId: "dispatching",
              payload: { persona: { kind: "none" }, text: "on its way" },
            },
          ]}
        />,
      );
      expect(screen.queryByText("on its way")).not.toBeInTheDocument();

      rerender(<ChatInput onSend={vi.fn()} isStreaming queuedMessages={[]} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(screen.queryByText("on its way")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a newly queued message immediately while the agent is responding", () => {
    const { rerender } = render(
      <ChatInput onSend={vi.fn()} queuedMessages={[]} isStreaming />,
    );

    rerender(
      <ChatInput
        onSend={vi.fn()}
        isStreaming
        queuedMessages={[
          {
            recordId: "responding-queue",
            payload: { persona: { kind: "none" }, text: "queue this" },
          },
        ]}
      />,
    );

    expect(screen.getByText("queue this")).toBeInTheDocument();
  });

  it("reveals a newly queued message when it remains after the grace period", async () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <ChatInput onSend={vi.fn()} queuedMessages={[]} />,
      );

      rerender(
        <ChatInput
          onSend={vi.fn()}
          queuedMessages={[
            {
              recordId: "waiting",
              payload: { persona: { kind: "none" }, text: "still waiting" },
            },
          ]}
        />,
      );
      expect(screen.queryByText("still waiting")).not.toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(199);
      });
      expect(screen.queryByText("still waiting")).not.toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(screen.getByText("still waiting")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a queue that already exists when the composer mounts", () => {
    render(
      <ChatInput
        onSend={vi.fn()}
        queuedMessages={[
          {
            recordId: "existing",
            payload: { persona: { kind: "none" }, text: "already waiting" },
          },
        ]}
      />,
    );

    expect(screen.getByText("already waiting")).toBeInTheDocument();
  });

  it("hides the queued pill for the record being edited", async () => {
    const onUpdateQueue = vi.fn(() => true);
    const user = userEvent.setup();
    const { rerender } = render(
      <ChatInput
        onSend={vi.fn()}
        queuedMessages={[
          {
            recordId: "head",
            payload: { persona: { kind: "none" as const }, text: "queued msg" },
          },
        ]}
        onEditQueue={vi.fn(() => true)}
        onCancelQueueEdit={vi.fn(() => true)}
        onDismissQueue={vi.fn()}
        onUpdateQueue={onUpdateQueue}
      />,
    );

    const queuedPills = () =>
      Array.from(document.querySelectorAll('[data-slot="queued-message"]')).map(
        (pill) => pill.textContent,
      );

    expect(queuedPills()).toEqual(
      expect.arrayContaining([expect.stringContaining("queued msg")]),
    );
    await user.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );

    // The message now lives in the composer, so its pill must disappear.
    expect(screen.getByRole("textbox")).toHaveValue("queued msg");
    expect(queuedPills()).toEqual([]);

    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "edited msg");
    await user.keyboard("{Enter}");

    expect(onUpdateQueue).toHaveBeenCalledWith("head", {
      text: "edited msg",
      persona: { kind: "none" },
      attachments: undefined,
      sendOptions: undefined,
    });

    // Once the edit is saved the pill returns with the updated text.
    rerender(
      <ChatInput
        onSend={vi.fn()}
        queuedMessages={[
          {
            recordId: "head",
            payload: { persona: { kind: "none" as const }, text: "edited msg" },
          },
        ]}
        onEditQueue={vi.fn(() => true)}
        onCancelQueueEdit={vi.fn(() => true)}
        onDismissQueue={vi.fn()}
        onUpdateQueue={onUpdateQueue}
      />,
    );
    expect(screen.getByText("edited msg")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("keeps head-only queue actions on the true head while a tail record is edited", async () => {
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={vi.fn()}
        onSteerQueuedMessage={vi.fn()}
        canSteerQueuedMessage
        isStreaming
        queuedMessages={[
          {
            recordId: "head",
            payload: { persona: { kind: "none" as const }, text: "first" },
          },
          {
            recordId: "tail",
            payload: { persona: { kind: "none" as const }, text: "second" },
          },
        ]}
        onEditQueue={vi.fn(() => true)}
        onCancelQueueEdit={vi.fn(() => true)}
        onDismissQueue={vi.fn()}
        onUpdateQueue={vi.fn(() => true)}
      />,
    );

    await user.click(
      screen.getAllByRole("button", { name: "Edit queued message" })[0],
    );

    // Editing the head hides its pill; the tail pill must not inherit
    // head-only actions like steering.
    await waitFor(() => {
      const pillTexts = Array.from(
        document.querySelectorAll('[data-slot="queued-message"]'),
      ).map((pill) => pill.textContent);
      expect(pillTexts).toHaveLength(1);
      expect(pillTexts[0]).toContain("second");
      expect(pillTexts[0]).not.toContain("first");
    });
    expect(screen.queryByTitle("Steer queued message")).not.toBeInTheDocument();
  });

  it("pauses a tail record while editing and updates it in place", async () => {
    const onEditQueue = vi.fn(() => true);
    const onCancelQueueEdit = vi.fn(() => true);
    const onUpdateQueue = vi.fn(() => true);
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={vi.fn()}
        queuedMessages={[
          {
            recordId: "head",
            payload: { persona: { kind: "none" }, text: "first" },
          },
          {
            recordId: "tail",
            payload: { persona: { kind: "none" }, text: "second" },
          },
        ]}
        onEditQueue={onEditQueue}
        onCancelQueueEdit={onCancelQueueEdit}
        onDismissQueue={vi.fn()}
        onUpdateQueue={onUpdateQueue}
      />,
    );

    const firstQueuedMessage = screen.getByText("first");
    const secondQueuedMessage = screen.getByText("second");
    expect(firstQueuedMessage).toBeInTheDocument();
    expect(secondQueuedMessage).toBeInTheDocument();
    const queuedMessageGroup =
      firstQueuedMessage.parentElement?.parentElement?.parentElement;
    expect(queuedMessageGroup).toBe(
      secondQueuedMessage.parentElement?.parentElement?.parentElement,
    );
    expect(queuedMessageGroup).toHaveAttribute(
      "data-slot",
      "queued-message-group",
    );
    expect(queuedMessageGroup).toHaveClass("rounded-xs");
    expect(queuedMessageGroup).not.toHaveClass("rounded-full");
    expect(screen.queryByText("1. first")).not.toBeInTheDocument();
    expect(screen.queryByText("2. second")).not.toBeInTheDocument();

    await user.click(
      screen.getAllByRole("button", { name: "Edit queued message" })[1],
    );
    expect(onEditQueue).toHaveBeenCalledWith("tail");
    expect(screen.getByRole("textbox")).toHaveValue("second");

    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "updated second");
    await user.keyboard("{Enter}");

    expect(onUpdateQueue).toHaveBeenCalledWith("tail", {
      text: "updated second",
      persona: { kind: "none" },
      attachments: undefined,
      sendOptions: undefined,
    });
    expect(onCancelQueueEdit).not.toHaveBeenCalled();
  });

  it("routes queued-edit voice auto-submit through the editor-local persona", async () => {
    const onSend = vi.fn();
    const onUpdateQueue = vi.fn(() => true);
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={onSend}
        personas={TEST_PERSONAS}
        selectedPersonaId="builtin-solo"
        onPersonaChange={vi.fn()}
        queuedMessages={[
          {
            recordId: "queued-review",
            payload: {
              persona: { kind: "persona", id: "reviewer" },
              text: "original",
            },
          },
        ]}
        onEditQueue={vi.fn(() => true)}
        onCancelQueueEdit={vi.fn(() => true)}
        onDismissQueue={vi.fn()}
        onUpdateQueue={onUpdateQueue}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    await user.clear(screen.getByRole("textbox"));
    await act(async () => {
      expect(await lastVoiceAutoSubmit?.("dictated revision")).toBe(true);
    });

    expect(onUpdateQueue).toHaveBeenCalledWith("queued-review", {
      text: "dictated revision",
      persona: { kind: "persona", id: "reviewer" },
      attachments: undefined,
      sendOptions: undefined,
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps non-edit voice auto-submit on the normal send path", async () => {
    const onSend = vi.fn(() => true);
    render(
      <ChatInput
        onSend={onSend}
        personas={TEST_PERSONAS}
        selectedPersonaId="builtin-solo"
      />,
    );

    await act(async () => {
      expect(await lastVoiceAutoSubmit?.("dictated message")).toBe(true);
    });

    expect(onSend).toHaveBeenCalledWith(
      "dictated message",
      "builtin-solo",
      undefined,
      expect.any(Object),
    );
  });

  it("keeps inherited queue persona editor-local across open and save", async () => {
    const onPersonaChange = vi.fn();
    const onUpdateQueue = vi.fn(() => true);
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={vi.fn()}
        personas={TEST_PERSONAS}
        selectedPersonaId="builtin-solo"
        onPersonaChange={onPersonaChange}
        queuedMessages={[
          {
            recordId: "inherited",
            payload: { persona: { kind: "inherit" }, text: "keep intent" },
          },
        ]}
        onEditQueue={vi.fn(() => true)}
        onCancelQueueEdit={vi.fn(() => true)}
        onDismissQueue={vi.fn()}
        onUpdateQueue={onUpdateQueue}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    expect(onPersonaChange).not.toHaveBeenCalled();
    expect(screen.queryByText("Solo")).not.toBeInTheDocument();

    await user.keyboard("{Enter}");

    expect(onUpdateQueue).toHaveBeenCalledWith("inherited", {
      text: "keep intent",
      persona: { kind: "inherit" },
      attachments: undefined,
      sendOptions: undefined,
    });
    expect(onPersonaChange).not.toHaveBeenCalled();
  });

  it("changes only the queued persona draft during edit", async () => {
    const onPersonaChange = vi.fn();
    const onUpdateQueue = vi.fn(() => true);
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={vi.fn()}
        personas={TEST_PERSONAS}
        selectedPersonaId="builtin-solo"
        onPersonaChange={onPersonaChange}
        queuedMessages={[
          {
            recordId: "inherited",
            payload: { persona: { kind: "inherit" }, text: "choose reviewer" },
          },
        ]}
        onEditQueue={vi.fn(() => true)}
        onCancelQueueEdit={vi.fn(() => true)}
        onDismissQueue={vi.fn()}
        onUpdateQueue={onUpdateQueue}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "@Rev");
    await user.click(screen.getByRole("option", { name: /reviewer/i }));
    await user.type(input, "choose reviewer");
    await user.keyboard("{Enter}");

    expect(onUpdateQueue).toHaveBeenCalledWith(
      "inherited",
      expect.objectContaining({
        persona: { kind: "persona", id: "reviewer" },
      }),
    );
    expect(onPersonaChange).not.toHaveBeenCalled();
  });

  it("does not stamp the live session target onto an edited queued message", async () => {
    const onUpdateQueue = vi.fn(() => true);
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={vi.fn()}
        selectedProvider="goose"
        providers={[{ id: "goose", label: "Goose" }]}
        currentExecutionTarget={{
          harnessId: "goose",
          modelProviderId: "databricks_v2",
        }}
        queuedMessages={[
          {
            recordId: "queued",
            payload: { persona: { kind: "none" }, text: "continue" },
          },
        ]}
        onEditQueue={vi.fn(() => true)}
        onCancelQueueEdit={vi.fn(() => true)}
        onDismissQueue={vi.fn()}
        onUpdateQueue={onUpdateQueue}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    await user.keyboard("{Enter}");

    expect(onUpdateQueue).toHaveBeenCalledWith("queued", {
      text: "continue",
      persona: { kind: "none" },
      attachments: undefined,
      sendOptions: undefined,
    });
  });

  it("refreshes display text when updating a queued message in place", async () => {
    const onUpdateQueue = vi.fn(() => true);
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={vi.fn()}
        queuedMessages={[
          {
            recordId: "head",
            payload: {
              persona: { kind: "none" },
              text: "check this diff",
              sendOptions: {
                assistantPrompt: "Use code-review.",
                displayText: "check this diff",
              },
            },
          },
        ]}
        onEditQueue={vi.fn(() => true)}
        onCancelQueueEdit={vi.fn(() => true)}
        onDismissQueue={vi.fn()}
        onUpdateQueue={onUpdateQueue}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "check carefully");
    await user.keyboard("{Enter}");

    expect(onUpdateQueue).toHaveBeenCalledWith(
      "head",
      expect.objectContaining({
        text: "check carefully",
        sendOptions: expect.objectContaining({
          assistantPrompt: "Use code-review.",
          displayText: "check carefully",
        }),
      }),
    );
  });

  it("resumes an edited queued record when the composer unmounts", async () => {
    const onEditQueue = vi.fn(() => true);
    const onCancelQueueEdit = vi.fn(() => true);
    const user = userEvent.setup();
    const { unmount } = render(
      <ChatInput
        onSend={vi.fn()}
        queuedMessages={[
          {
            recordId: "head",
            payload: { persona: { kind: "none" as const }, text: "queued msg" },
          },
        ]}
        onEditQueue={onEditQueue}
        onCancelQueueEdit={onCancelQueueEdit}
        onDismissQueue={vi.fn()}
        onUpdateQueue={vi.fn(() => true)}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    expect(onEditQueue).toHaveBeenCalledWith("head");

    unmount();
    expect(onCancelQueueEdit).toHaveBeenCalledWith("head");
  });

  it("clears the composer edit state when the edited record leaves the queue", async () => {
    const onSend = vi.fn(() => true);
    const onUpdateQueue = vi.fn(() => true);
    const user = userEvent.setup();

    const queueProps = {
      onEditQueue: vi.fn(() => true),
      onCancelQueueEdit: vi.fn(() => true),
      onDismissQueue: vi.fn(),
      onUpdateQueue,
    };
    const { rerender } = render(
      <ChatInput
        onSend={onSend}
        queuedMessages={[
          {
            recordId: "head",
            payload: { persona: { kind: "none" as const }, text: "queued msg" },
          },
        ]}
        {...queueProps}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );

    // The record leaves the queue externally (for example the queue drains)
    // while its text is still in the composer.
    rerender(<ChatInput onSend={onSend} queuedMessages={[]} {...queueProps} />);

    // The edit must also be canceled in the store: if the record was only
    // filtered out of the prop (composer handoff), a lingering editing flag
    // would block the queue from draining it.
    expect(queueProps.onCancelQueueEdit).toHaveBeenCalledWith("head");

    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "new prompt");
    await user.keyboard("{Enter}");

    expect(onUpdateQueue).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith("new prompt", null, undefined);
  });

  it("hides reliable startup handoffs from the queue bar", () => {
    render(
      <ChatInput
        onSend={vi.fn()}
        queuedMessage={{
          persona: { kind: "none" },
          text: "first message",
          showInComposer: false,
        }}
      />,
    );

    expect(screen.queryByText("Queued: first message")).not.toBeInTheDocument();
  });

  it("edits a queued message from the queue bar", async () => {
    const onDismissQueue = vi.fn();
    const onPersonaChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={vi.fn()}
        onDismissQueue={onDismissQueue}
        onPersonaChange={onPersonaChange}
        queuedMessage={{
          persona: { kind: "persona", id: "reviewer" },
          text: "queued msg",
          attachments: [
            {
              id: "file-1",
              kind: "file" as const,
              name: "notes.txt",
              path: "/tmp/notes.txt",
            },
          ],
        }}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );

    expect(onDismissQueue).toHaveBeenCalledOnce();
    expect(onPersonaChange).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("queued msg");
    expect(screen.getByRole("textbox")).toHaveFocus();
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
  });

  it("keeps tagged agents, skill send options, and attachments when editing a queued message", async () => {
    const onSend = vi.fn(() => true);
    const user = userEvent.setup();

    function EditableQueuedMessageInput() {
      const [selectedPersonaId, setSelectedPersonaId] = useState<string | null>(
        null,
      );
      const [queuedMessage, setQueuedMessage] = useState<
        ChatInputComposerActions["queuedMessage"]
      >({
        persona: { kind: "persona", id: "reviewer" },
        text: "@Reviewer check this diff",
        attachments: [
          {
            id: "file-1",
            kind: "file" as const,
            name: "notes.txt",
            path: "/tmp/notes.txt",
          },
        ],
        sendOptions: {
          assistantPrompt: "Use these skills for this request: code-review.",
          displayText: "@Reviewer check this diff",
          chips: [
            {
              id: "reviewer",
              label: "Reviewer",
              agentRole: "active" as const,
              type: "agent" as const,
            },
            { label: "code-review", type: "skill" as const },
          ],
        },
      });

      return (
        <ChatInput
          onSend={onSend}
          personas={TEST_PERSONAS}
          selectedPersonaId={selectedPersonaId}
          onPersonaChange={setSelectedPersonaId}
          onDismissQueue={() => setQueuedMessage(null)}
          queuedMessage={queuedMessage}
        />
      );
    }

    render(<EditableQueuedMessageInput />);

    await user.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );

    expect(screen.getByRole("textbox")).toHaveValue(
      "@Reviewer check this diff",
    );
    expect(screen.getByText("Reviewer")).toBeInTheDocument();
    expect(screen.getByText("notes.txt")).toBeInTheDocument();

    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith(
      "@Reviewer check this diff",
      "reviewer",
      [
        {
          id: "file-1",
          kind: "file",
          name: "notes.txt",
          path: "/tmp/notes.txt",
        },
      ],
      {
        assistantPrompt: "Use these skills for this request: code-review.",
        chips: [
          {
            id: "reviewer",
            label: "Reviewer",
            agentRole: "active",
            type: "agent",
          },
          { label: "code-review", type: "skill" },
        ],
        displayText: "@Reviewer check this diff",
      },
    );
  });

  it("drops derived execution context when resending an edited message", async () => {
    const onSend = vi.fn(() => true);
    const onDismissQueue = vi.fn();
    const user = userEvent.setup();

    function EditableQueuedMessageInput() {
      const [queuedMessage, setQueuedMessage] = useState<
        ChatInputComposerActions["queuedMessage"]
      >({
        persona: { kind: "none" },
        text: "check this diff",
        sendOptions: {
          assistantPrompt: "Use these skills for this request: code-review.",
          chips: [{ label: "code-review", type: "skill" as const }],
          displayText: "check this diff",
          executionSystemPrompt: "stale queued context",
        },
      });

      return (
        <ChatInput
          onSend={onSend}
          onDismissQueue={() => {
            onDismissQueue();
            setQueuedMessage(null);
          }}
          queuedMessage={queuedMessage}
        />
      );
    }

    render(<EditableQueuedMessageInput />);

    const input = screen.getByRole("textbox");
    await user.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    await user.clear(input);
    await user.type(input, "check this diff carefully");
    await user.keyboard("{Enter}");

    expect(onDismissQueue).toHaveBeenCalledOnce();
    expect(onSend).toHaveBeenCalledWith(
      "check this diff carefully",
      null,
      undefined,
      {
        assistantPrompt: "Use these skills for this request: code-review.",
        chips: [{ label: "code-review", type: "skill" }],
        displayText: "check this diff carefully",
      },
    );
  });

  it("refreshes persona chips when resending an edited queued message", async () => {
    const onSend = vi.fn(() => true);
    const user = userEvent.setup();

    function EditableQueuedMessageWithPersona() {
      const [selectedPersonaId, setSelectedPersonaId] = useState<string | null>(
        "builtin-solo",
      );
      const [queuedMessage, setQueuedMessage] = useState<
        ChatInputComposerActions["queuedMessage"]
      >({
        persona: { kind: "persona", id: "builtin-solo" },
        text: "queued msg",
        sendOptions: {
          assistantPrompt: "Use these skills for this request: code-review.",
          chips: [
            {
              id: "builtin-solo",
              label: "Solo",
              agentRole: "active" as const,
              type: "agent" as const,
            },
            { label: "code-review", type: "skill" as const },
          ],
          displayText: "queued msg",
        },
      });

      return (
        <ChatInput
          onSend={onSend}
          personas={TEST_PERSONAS}
          selectedPersonaId={selectedPersonaId}
          onPersonaChange={setSelectedPersonaId}
          onDismissQueue={() => setQueuedMessage(null)}
          queuedMessage={queuedMessage}
        />
      );
    }

    render(<EditableQueuedMessageWithPersona />);

    const input = screen.getByRole("textbox");
    await user.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    await user.click(screen.getByRole("button", { name: "Remove Solo agent" }));
    await user.clear(input);
    await user.type(input, "@Rev");
    await user.click(screen.getByRole("option", { name: /reviewer/i }));
    await user.type(input, "now with reviewer");
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith(
      "@Reviewer now with reviewer",
      "reviewer",
      undefined,
      {
        assistantPrompt: "Use these skills for this request: code-review.",
        chips: [
          {
            id: "reviewer",
            label: "Reviewer",
            agentRole: "active",
            type: "agent",
          },
          { label: "code-review", type: "skill" },
        ],
        displayText: "@Reviewer now with reviewer",
      },
    );
  });

  it("strips cross-session delivery metadata when resending an edited queued message", async () => {
    const onSend = vi.fn(() => true);
    const user = userEvent.setup();

    function EditableCrossSessionQueuedMessageInput() {
      const [queuedMessage, setQueuedMessage] = useState<
        ChatInputComposerActions["queuedMessage"]
      >({
        persona: { kind: "none" },
        text: "queued from another session",
        sendOptions: {
          acpGooseMetadata: {
            origin: "berdctl_cross_session",
            berdSenderLabel: "berd-monitor",
            berdDeliveryId: "event-1",
            threadId: "thread-1",
          },
          userMessageMetadata: {
            origin: "berdctl_cross_session",
            berdSenderLabel: "berd-monitor",
            berdDeliveryId: "event-1",
          },
        },
      });

      return (
        <ChatInput
          onSend={onSend}
          onDismissQueue={() => setQueuedMessage(null)}
          queuedMessage={queuedMessage}
        />
      );
    }

    render(<EditableCrossSessionQueuedMessageInput />);

    const input = screen.getByRole("textbox");
    await user.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    await user.clear(input);
    await user.type(input, "now from me");
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith("now from me", null, undefined, {
      acpGooseMetadata: {
        threadId: "thread-1",
      },
    });
  });

  it("steers the queued message on enter with an empty composer", async () => {
    const onSend = vi.fn();
    const onSteerQueuedMessage = vi.fn();
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={onSend}
        onSteerQueuedMessage={onSteerQueuedMessage}
        canSteerQueuedMessage
        isStreaming
        queuedMessage={{ persona: { kind: "none" }, text: "queued msg" }}
      />,
    );

    await user.keyboard("{Enter}");

    expect(onSteerQueuedMessage).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("steers the queued message on cmd-enter with an empty composer", async () => {
    const onSend = vi.fn();
    const onSteerQueuedMessage = vi.fn();
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={onSend}
        onSteerQueuedMessage={onSteerQueuedMessage}
        canSteerQueuedMessage
        isStreaming
        queuedMessage={{ persona: { kind: "none" }, text: "queued msg" }}
      />,
    );

    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(onSteerQueuedMessage).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not steer the queued message on enter when the session is idle", async () => {
    const onSend = vi.fn();
    const onSteerQueuedMessage = vi.fn();
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={onSend}
        onSteerQueuedMessage={onSteerQueuedMessage}
        canSteerQueuedMessage
        queuedMessage={{ persona: { kind: "none" }, text: "queued msg" }}
      />,
    );

    await user.keyboard("{Enter}");

    expect(onSteerQueuedMessage).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not offer steering while a hidden record heads the queue", async () => {
    const onSend = vi.fn();
    const onSteerQueuedMessage = vi.fn();
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={onSend}
        onSteerQueuedMessage={onSteerQueuedMessage}
        canSteerQueuedMessage
        isStreaming
        queuedMessages={[
          {
            recordId: "hidden-head",
            payload: {
              persona: { kind: "none" as const },
              text: "startup handoff",
              showInComposer: false,
            },
          },
          {
            recordId: "visible-tail",
            payload: {
              persona: { kind: "none" as const },
              text: "queued msg",
            },
          },
        ]}
      />,
    );

    expect(screen.queryByTitle("Steer queued message")).not.toBeInTheDocument();
    await user.keyboard("{Enter}");

    expect(onSteerQueuedMessage).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not steer the queued message while it is being edited", async () => {
    const onSteerQueuedMessage = vi.fn();
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={vi.fn()}
        onSteerQueuedMessage={onSteerQueuedMessage}
        canSteerQueuedMessage
        isStreaming
        queuedMessages={[
          {
            recordId: "head",
            payload: { persona: { kind: "none" as const }, text: "queued msg" },
          },
        ]}
        onEditQueue={vi.fn(() => true)}
        onCancelQueueEdit={vi.fn(() => true)}
        onDismissQueue={vi.fn()}
        onUpdateQueue={vi.fn(() => true)}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    await user.clear(screen.getByRole("textbox"));
    await user.keyboard("{Enter}");

    expect(onSteerQueuedMessage).not.toHaveBeenCalled();
  });

  it("appends a draft without steering the queued head", async () => {
    const onSend = vi.fn();
    const onSteerQueuedMessage = vi.fn();
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={onSend}
        onSteerQueuedMessage={onSteerQueuedMessage}
        canSteerQueuedMessage
        isStreaming
        queuedMessage={{ persona: { kind: "none" }, text: "queued msg" }}
      />,
    );

    await user.type(screen.getByRole("textbox"), "another draft");
    await user.keyboard("{Enter}");

    expect(onSteerQueuedMessage).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith("another draft", null, undefined);
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("queues the current draft behind an existing head instead of steering it", async () => {
    const onSend = vi.fn();
    const onSteerMessage = vi.fn();
    const onSteerQueuedMessage = vi.fn();
    const user = userEvent.setup();
    localStorage.setItem(STREAMING_SHORTCUT_MODE_STORAGE_KEY, "enter-steers");
    render(
      <ChatInput
        onSend={onSend}
        onSteerMessage={onSteerMessage}
        onSteerQueuedMessage={onSteerQueuedMessage}
        canSteerMessage
        canSteerQueuedMessage
        isStreaming
        queuedMessage={{ persona: { kind: "none" }, text: "queued msg" }}
      />,
    );

    await user.type(screen.getByRole("textbox"), "new queued draft");
    await user.keyboard("{Enter}");

    expect(onSteerMessage).not.toHaveBeenCalled();
    expect(onSteerQueuedMessage).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith("new queued draft", null, undefined);
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("updates an edited queued record instead of steering ahead of it", async () => {
    const onSend = vi.fn();
    const onSteerMessage = vi.fn();
    const onCancelQueueEdit = vi.fn(() => true);
    const onUpdateQueue = vi.fn(() => true);
    const user = userEvent.setup();
    localStorage.setItem(STREAMING_SHORTCUT_MODE_STORAGE_KEY, "enter-steers");
    render(
      <ChatInput
        onSend={onSend}
        onSteerMessage={onSteerMessage}
        canSteerMessage
        isStreaming
        queuedMessages={[
          {
            recordId: "head",
            payload: { persona: { kind: "none" }, text: "queued draft" },
          },
        ]}
        onEditQueue={vi.fn(() => true)}
        onCancelQueueEdit={onCancelQueueEdit}
        onDismissQueue={vi.fn()}
        onUpdateQueue={onUpdateQueue}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "keep this queued");
    await user.keyboard("{Enter}");

    expect(onSteerMessage).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(onUpdateQueue).toHaveBeenCalledWith("head", {
      text: "keep this queued",
      persona: { kind: "none" },
      attachments: undefined,
      sendOptions: undefined,
    });
    expect(onCancelQueueEdit).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("queues on cmd-enter when enter is configured to steer", async () => {
    const onSend = vi.fn();
    const onSteerMessage = vi.fn();
    const user = userEvent.setup();
    localStorage.setItem(STREAMING_SHORTCUT_MODE_STORAGE_KEY, "enter-steers");
    render(
      <ChatInput
        onSend={onSend}
        onSteerMessage={onSteerMessage}
        canSteerMessage
        isStreaming
      />,
    );

    await user.type(screen.getByRole("textbox"), "follow up");
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(onSend).toHaveBeenCalledWith("follow up", null, undefined);
    expect(onSteerMessage).not.toHaveBeenCalled();
  });

  it("steers on enter when enter is configured to steer", async () => {
    const onSend = vi.fn();
    const onSteerMessage = vi.fn();
    const user = userEvent.setup();
    localStorage.setItem(STREAMING_SHORTCUT_MODE_STORAGE_KEY, "enter-steers");
    render(
      <ChatInput
        onSend={onSend}
        onSteerMessage={onSteerMessage}
        canSteerMessage
        isStreaming
      />,
    );

    await user.type(screen.getByRole("textbox"), "follow up");
    await user.keyboard("{Enter}");

    expect(onSteerMessage).toHaveBeenCalledWith(
      "follow up",
      undefined,
      undefined,
    );
    expect(onSend).not.toHaveBeenCalled();
  });

  it("clears a steering draft without waiting for acknowledgement", async () => {
    const steerDeferred = deferred<boolean>();
    const onSteerMessage = vi.fn(() => steerDeferred.promise);
    const user = userEvent.setup();
    localStorage.setItem(STREAMING_SHORTCUT_MODE_STORAGE_KEY, "enter-steers");
    render(
      <ChatInput
        onSend={vi.fn()}
        onSteerMessage={onSteerMessage}
        canSteerMessage
        isStreaming
      />,
    );

    const input = screen.getByRole("textbox");
    await user.type(input, "follow up");
    await user.keyboard("{Enter}");

    expect(onSteerMessage).toHaveBeenCalledOnce();
    expect(input).toHaveValue("");

    await user.keyboard("{Enter}{Enter}");
    expect(onSteerMessage).toHaveBeenCalledOnce();

    steerDeferred.resolve(false);
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("preserves restored queued options when steering an edited message", async () => {
    const onSteerMessage = vi.fn();
    const user = userEvent.setup();
    localStorage.setItem(STREAMING_SHORTCUT_MODE_STORAGE_KEY, "enter-steers");

    function EditableQueuedSteerInput() {
      const [queuedMessage, setQueuedMessage] = useState<
        ChatInputComposerActions["queuedMessage"]
      >({
        persona: { kind: "none" },
        text: "check this diff",
        sendOptions: {
          assistantPrompt: "Use these skills for this request: code-review.",
          chips: [{ label: "code-review", type: "skill" as const }],
          displayText: "check this diff",
        },
      });
      return (
        <ChatInput
          onSend={vi.fn()}
          onSteerMessage={onSteerMessage}
          canSteerMessage
          isStreaming
          onDismissQueue={() => setQueuedMessage(null)}
          queuedMessage={queuedMessage}
        />
      );
    }

    render(<EditableQueuedSteerInput />);
    const input = screen.getByRole("textbox");
    await user.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    await user.clear(input);
    await user.type(input, "check this diff carefully");
    await user.keyboard("{Enter}");

    expect(onSteerMessage).toHaveBeenCalledWith(
      "check this diff carefully",
      undefined,
      undefined,
      {
        assistantPrompt: "Use these skills for this request: code-review.",
        chips: [{ label: "code-review", type: "skill" }],
        displayText: "check this diff carefully",
      },
    );
    expect(input).toHaveValue("");
  });

  it("clears steering skills and attachments immediately", async () => {
    const steerDeferred = deferred<boolean>();
    const onSteerMessage = vi.fn(() => steerDeferred.promise);
    const onSkillsChange = vi.fn();
    const onDraftAttachmentsChange = vi.fn();
    const user = userEvent.setup();
    localStorage.setItem(STREAMING_SHORTCUT_MODE_STORAGE_KEY, "enter-steers");
    render(
      <ChatInput
        onSend={vi.fn()}
        onSteerMessage={onSteerMessage}
        canSteerMessage
        isStreaming
        selectedSkills={[{ id: "code-review", name: "code-review" }]}
        onSkillsChange={onSkillsChange}
        initialAttachments={[
          {
            id: "file-1",
            kind: "file",
            name: "notes.txt",
          },
        ]}
        onDraftAttachmentsChange={onDraftAttachmentsChange}
      />,
    );

    await user.keyboard("{Enter}");

    expect(onSteerMessage).toHaveBeenCalledOnce();
    expect(onSkillsChange).toHaveBeenCalledWith([]);
    expect(onDraftAttachmentsChange).toHaveBeenLastCalledWith([]);
    expect(screen.queryByText("notes.txt")).not.toBeInTheDocument();

    steerDeferred.resolve(false);
    await waitFor(() => expect(onSteerMessage).toHaveBeenCalledOnce());
  });

  it("keeps an oversized steer draft in the composer instead of steering", async () => {
    // Discriminating test for the synchronous budget guard in
    // handleSteerCurrentMessage: steering is fire-and-forget (the draft
    // clears before acknowledgement), so without the guard an oversized
    // draft would be discarded even though nothing was sent (BOT-1463).
    const onSteerMessage = vi.fn();
    const onDraftAttachmentsChange = vi.fn();
    const user = userEvent.setup();
    localStorage.setItem(STREAMING_SHORTCUT_MODE_STORAGE_KEY, "enter-steers");
    render(
      <ChatInput
        onSend={vi.fn()}
        onSteerMessage={onSteerMessage}
        canSteerMessage
        isStreaming
        initialAttachments={[
          {
            id: "image-1",
            kind: "image",
            name: "huge.jpeg",
            mimeType: "image/jpeg",
            base64: "x".repeat(MAX_PROMPT_ATTACHMENT_BYTES + 1),
            previewUrl: "blob:huge",
          },
        ]}
        onDraftAttachmentsChange={onDraftAttachmentsChange}
      />,
    );

    const input = screen.getByRole("textbox");
    await user.type(input, "look at this");
    await user.keyboard("{Enter}");

    // Nothing steers and nothing clears: the draft survives for the user
    // to remove attachments and retry.
    expect(onSteerMessage).not.toHaveBeenCalled();
    expect(input).toHaveValue("look at this");
    expect(onDraftAttachmentsChange).not.toHaveBeenCalledWith([]);
  });

  it("allows another draft to append while a message is queued", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={onSend}
        isStreaming
        queuedMessage={{ persona: { kind: "none" }, text: "queued msg" }}
      />,
    );

    await user.type(screen.getByRole("textbox"), "another message");
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith("another message", null, undefined);
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("stops dictation when appending to the queue", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    mockVoiceDictation.isRecording = true;

    render(
      <ChatInput
        onSend={onSend}
        isStreaming
        queuedMessage={{ persona: { kind: "none" }, text: "queued msg" }}
      />,
    );

    await user.type(screen.getByRole("textbox"), "another message");
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith("another message", null, undefined);
    expect(mockVoiceDictation.stopRecording).toHaveBeenCalled();
  });

  it("uses icon-only picker triggers in compact toolbar layout", () => {
    render(
      <ChatInputToolbar
        agentModelPicker={{
          providers: [{ id: "goose", label: "Goose" }],
          selectedProvider: "goose",
          onProviderChange: vi.fn(),
          availableModels: [{ id: "gpt-4o", name: "GPT-4o" }],
        }}
        projectPicker={{
          selectedProjectId: "project-1",
          availableProjects: [
            {
              id: "project-1",
              name: "berd",
              workingDirs: ["/workspace/goose"],
            },
          ],
        }}
        contextUsage={{
          contextTokens: 0,
          contextLimit: 0,
        }}
        composerActions={{
          canSend: false,
          isStreaming: false,
          onSend: vi.fn(),
        }}
        isCompact
      />,
    );

    const modelTrigger = screen.getByRole("button", {
      name: /choose agent and model/i,
    });
    const projectTrigger = screen.getByRole("button", {
      name: /select project/i,
    });

    expect(modelTrigger).toHaveTextContent("");
    expect(projectTrigger).toHaveTextContent("");
    expect(modelTrigger).toHaveClass("h-8", "w-10");
    expect(projectTrigger).toHaveClass("h-8", "w-10");
    expect(modelTrigger).not.toHaveAttribute("title");
    expect(projectTrigger).not.toHaveAttribute("title");
  });

  it("keeps the model picker open when clicked after the attach menu", async () => {
    const user = userEvent.setup();

    render(
      <ChatInputToolbar
        agentModelPicker={{
          providers: [{ id: "goose", label: "Goose" }],
          selectedProvider: "goose",
          onProviderChange: vi.fn(),
          availableModels: [{ id: "gpt-4o", name: "GPT-4o" }],
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
          attachmentsEnabled: true,
          onAttachFiles: vi.fn(),
          onAttachFolders: vi.fn(),
          onSend: vi.fn(),
        }}
        isCompact={false}
      />,
    );

    const modelPickerTrigger = screen.getByRole("button", {
      name: /choose agent and model/i,
    });

    await user.click(screen.getByRole("button", { name: /attach/i }));
    expect(screen.getByRole("menuitem", { name: "File" })).toBeInTheDocument();

    fireEvent.pointerDown(modelPickerTrigger, {
      pointerType: "mouse",
      button: 0,
      ctrlKey: false,
    });
    fireEvent.pointerUp(modelPickerTrigger, { pointerType: "mouse" });
    fireEvent.click(modelPickerTrigger);

    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.getByText("Model")).toBeInTheDocument();
    expect(screen.queryByText("Attach file")).not.toBeInTheDocument();
  });

  it("keeps only one dropdown menu open when switching between attach and project", async () => {
    const user = userEvent.setup();

    render(
      <ChatInputToolbar
        agentModelPicker={{
          providers: [{ id: "goose", label: "Goose" }],
          selectedProvider: "goose",
          onProviderChange: vi.fn(),
          availableModels: [{ id: "gpt-4o", name: "GPT-4o" }],
        }}
        projectPicker={{
          selectedProjectId: "project-1",
          availableProjects: [
            {
              id: "project-1",
              name: "berd",
              workingDirs: ["/workspace/goose"],
            },
          ],
        }}
        contextUsage={{
          contextTokens: 0,
          contextLimit: 0,
        }}
        composerActions={{
          canSend: false,
          isStreaming: false,
          attachmentsEnabled: true,
          onAttachFiles: vi.fn(),
          onAttachFolders: vi.fn(),
          onSend: vi.fn(),
        }}
        isCompact={false}
      />,
    );

    const attachTrigger = screen.getByRole("button", { name: "Attach" });
    const projectTrigger = screen.getByRole("button", {
      name: /select project/i,
    });

    await user.click(attachTrigger);
    expect(screen.getByRole("menuitem", { name: "File" })).toBeInTheDocument();

    await user.click(projectTrigger);
    expect(screen.getByText("Choose a project")).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "File" }),
    ).not.toBeInTheDocument();

    await user.click(attachTrigger);
    expect(screen.getByRole("menuitem", { name: "File" })).toBeInTheDocument();
    expect(screen.queryByText("Choose a project")).not.toBeInTheDocument();
  });

  it("restores composer tooltips after switching from attach to model", async () => {
    const user = userEvent.setup();

    render(
      <ChatInputToolbar
        agentModelPicker={{
          providers: [{ id: "goose", label: "Goose" }],
          selectedProvider: "goose",
          onProviderChange: vi.fn(),
          availableModels: [{ id: "gpt-4o", name: "GPT-4o" }],
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
          attachmentsEnabled: true,
          onAttachFiles: vi.fn(),
          onAttachFolders: vi.fn(),
          onSend: vi.fn(),
          voiceEnabled: true,
          onVoiceToggle: vi.fn(),
          voiceConversation: {
            visible: true,
            state: "off",
            boundSessionId: null,
            active: false,
            microphoneMuted: false,
            onToggle: vi.fn(),
            onMicrophoneMuteToggle: vi.fn(),
          },
        }}
        isCompact={false}
      />,
    );

    const attachTrigger = screen.getByRole("button", { name: "Attach" });
    const modelTrigger = screen.getByRole("button", {
      name: /choose agent and model/i,
    });
    await user.click(attachTrigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.pointerDown(modelTrigger, {
      pointerType: "mouse",
      button: 0,
      ctrlKey: false,
    });
    fireEvent.pointerUp(modelTrigger, { pointerType: "mouse" });
    fireEvent.click(modelTrigger);
    expect(screen.getByText("Agent")).toBeInTheDocument();

    fireEvent.pointerDown(modelTrigger, {
      pointerType: "mouse",
      button: 0,
      ctrlKey: false,
    });
    fireEvent.pointerUp(modelTrigger, { pointerType: "mouse" });
    fireEvent.click(modelTrigger);
    expect(screen.queryByText("Agent")).not.toBeInTheDocument();

    const voiceConversationTrigger = screen.getByRole("button", {
      name: "Start voice conversation",
    });
    await user.hover(voiceConversationTrigger);
    expect(
      await screen.findByRole("tooltip", {
        name: "Start voice conversation",
      }),
    ).toBeInTheDocument();
    await user.unhover(voiceConversationTrigger);

    const dictationTrigger = screen.getByRole("button", {
      name: "Voice dictation",
    });
    await user.hover(dictationTrigger);
    expect(
      await screen.findByRole("tooltip", { name: "Voice dictation" }),
    ).toBeInTheDocument();
  });

  it("keeps the model picker open when clicked after the project picker", async () => {
    const user = userEvent.setup();

    render(
      <ChatInputToolbar
        agentModelPicker={{
          providers: [{ id: "goose", label: "Goose" }],
          selectedProvider: "goose",
          onProviderChange: vi.fn(),
          availableModels: [{ id: "gpt-4o", name: "GPT-4o" }],
        }}
        projectPicker={{
          selectedProjectId: "project-1",
          availableProjects: [
            {
              id: "project-1",
              name: "berd",
              workingDirs: ["/workspace/goose"],
            },
          ],
        }}
        contextUsage={{
          contextTokens: 0,
          contextLimit: 0,
        }}
        composerActions={{
          canSend: false,
          isStreaming: false,
          onSend: vi.fn(),
        }}
        isCompact={false}
      />,
    );

    const modelPickerTrigger = screen.getByRole("button", {
      name: /choose agent and model/i,
    });

    await user.click(screen.getByRole("button", { name: /select project/i }));
    expect(screen.getByText("Choose a project")).toBeInTheDocument();

    fireEvent.pointerDown(modelPickerTrigger);
    fireEvent.pointerUp(modelPickerTrigger);
    fireEvent.click(modelPickerTrigger);

    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.getByText("Model")).toBeInTheDocument();
    expect(screen.queryByText("Choose a project")).not.toBeInTheDocument();
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

  it("hides the mic toggle when voice input is unavailable and idle", () => {
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
          onSend: vi.fn(),
          voiceEnabled: false,
          voiceRecording: false,
          onVoiceToggle: vi.fn(),
        }}
        isCompact={false}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Voice dictation" }),
    ).not.toBeInTheDocument();
  });

  it("keeps voice-call mute immediately left of hang-up", async () => {
    const onMicrophoneMuteToggle = vi.fn();
    const user = userEvent.setup();

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
          onSend: vi.fn(),
          voiceEnabled: true,
          voiceConversation: {
            visible: true,
            state: "listening",
            boundSessionId: "session-1",
            active: true,
            microphoneMuted: false,
            onToggle: vi.fn(),
            onMicrophoneMuteToggle,
          },
        }}
        isCompact={false}
      />,
    );

    const callButton = screen.getByRole("button", { name: "Hang up" });
    const muteButton = screen.getByRole("button", {
      name: "Mute microphone",
    });

    expect(
      muteButton.compareDocumentPosition(callButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(muteButton).toHaveAttribute("aria-pressed", "false");

    await user.click(muteButton);
    expect(onMicrophoneMuteToggle).toHaveBeenCalledOnce();
  });

  it("shows and updates reasoning effort from the model picker", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();

    render(
      <ChatInputToolbar
        agentModelPicker={{
          providers: [],
          selectedProvider: "goose",
          onProviderChange: vi.fn(),
          availableModels: [],
        }}
        reasoningEffort={{
          config: {
            configId: "thinking_effort",
            currentValue: "medium",
            options: [
              { id: "off", name: "off" },
              { id: "medium", name: "medium" },
              { id: "high", name: "high" },
            ],
          },
          onChange,
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
          onSend: vi.fn(),
        }}
        isCompact={false}
      />,
    );

    const pickerTrigger = screen.getByRole("button", {
      name: /choose agent and model/i,
    });
    expect(pickerTrigger).toHaveTextContent("Medium");

    await user.click(pickerTrigger);
    await user.click(screen.getByRole("button", { name: "High" }));

    expect(onChange).toHaveBeenCalledWith("high");
  });

  it("hides reasoning effort when there is only one available value", () => {
    render(
      <ChatInputToolbar
        agentModelPicker={{
          providers: [],
          selectedProvider: "goose",
          onProviderChange: vi.fn(),
          availableModels: [],
        }}
        reasoningEffort={{
          config: {
            configId: "thinking_effort",
            currentValue: "off",
            options: [{ id: "off", name: "off" }],
          },
          onChange: vi.fn(),
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
          onSend: vi.fn(),
        }}
        isCompact={false}
      />,
    );

    expect(
      screen.getByRole("button", { name: /choose agent and model/i }),
    ).not.toHaveTextContent("Off");
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

    expect(onSend).toHaveBeenCalledWith(
      "@Reviewer hello",
      "reviewer",
      undefined,
      {
        chips: [
          {
            id: "reviewer",
            label: "Reviewer",
            agentRole: "active",
            type: "agent",
          },
        ],
      },
    );
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
        persona: { kind: "persona", id: "persona-1" },
        text: "queued follow up",
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
    expect(onPersonaChange).not.toHaveBeenCalled();
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
    expect(onSend).toHaveBeenCalledWith("hello", null, undefined);
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

    expect(onSend).toHaveBeenCalledWith("hello", null, undefined);
  });
});
