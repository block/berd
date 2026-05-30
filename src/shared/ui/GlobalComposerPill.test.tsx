import {
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
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
const mockListFilesForMentions = vi.fn();
const mockResizeImage = vi.fn();

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
  listFilesForMentions: (roots: string[], maxResults?: number) =>
    mockListFilesForMentions(roots, maxResults),
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
    getModelsForAgent: () => [],
    refreshAllModelProviders: vi.fn().mockResolvedValue(undefined),
    modelCacheRefreshProviderIds: [],
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
    mockListFilesForMentions.mockReset();
    mockResizeImage.mockReset();
    mockOpenDialog.mockResolvedValue(null);
    mockInspectAttachmentPaths.mockResolvedValue([]);
    mockReadImageAttachment.mockResolvedValue({
      base64: "path-image",
      mimeType: "image/png",
    });
    mockListFilesForMentions.mockResolvedValue([]);
    mockResizeImage.mockImplementation((file: File) =>
      Promise.resolve({ base64: `base64:${file.name}`, mimeType: file.type }),
    );
    vi.unstubAllGlobals();
    delete window.__TAURI_INTERNALS__;
    localStorage.clear();
    localStorage.setItem("goose:defaultProvider", "goose");
    useAgentStore.setState({
      personas: [],
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

  it("inserts selected project file mentions as paths", async () => {
    const user = userEvent.setup();
    renderGlobalComposer();
    mockListFilesForMentions.mockResolvedValue([
      "/workspace/project/src/readme.md",
    ]);

    await user.click(screen.getByRole("textbox"));
    await user.click(screen.getByRole("button", { name: /select project/i }));
    await user.click(screen.getByRole("button", { name: "Project One" }));

    await waitFor(() => {
      expect(mockListFilesForMentions).toHaveBeenCalledWith(
        ["/workspace/project"],
        undefined,
      );
    });

    await user.type(screen.getByRole("textbox"), "@read");
    await user.click(
      await screen.findByRole("option", { name: /readme\.md/i }),
    );

    expect(screen.getByRole("textbox")).toHaveValue(
      "/workspace/project/src/readme.md ",
    );
  });
});
