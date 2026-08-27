import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

const agentTelemetryMocks = vi.hoisted(() => ({
  trackAgentCreateCompleted: vi.fn(),
  trackAgentEditCompleted: vi.fn(),
  trackAgentDeleteCompleted: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: toastMocks,
}));

vi.mock("@/features/agents/lib/agentTelemetry", () => agentTelemetryMocks);

vi.mock("@/features/agents/hooks/usePersonaSource", () => ({
  usePersonaSource: vi.fn(),
}));

vi.mock("@/features/agents/lib/agentBuilderSession", () => ({
  promoteDraft: vi.fn(),
  fileStem: (path: string) => path.split("/").pop()?.replace(/\.md$/, ""),
  isPlaceholderAgentName: (name: string) =>
    name === "Untitled agent" || name.startsWith("Untitled agent "),
  PLACEHOLDER_AGENT_NAME: "Untitled agent",
  PLACEHOLDER_AGENT_BODY: "Draft in progress.",
  PLACEHOLDER_AGENT_DESCRIPTION: "Draft",
}));

vi.mock("@/features/agents/hooks/useAvatarLibrary", () => ({
  useAvatarLibrary: vi.fn(() => ({
    catalog: null,
    userAvatarIds: [],
    userAvatarMediaById: {},
    cachedAvatarMediaById: {},
    loading: false,
    cacheChecking: false,
    error: false,
    errorCode: null,
    mediaError: false,
    mediaErrorCode: null,
    retryCatalog: vi.fn(),
    retryMedia: vi.fn(),
  })),
}));

vi.mock("@/features/agents/stores/agentStore", () => ({
  useAgentStore: vi.fn((selector?: (state: unknown) => unknown) => {
    const state = { providers: [], personas: [] };
    return selector ? selector(state) : state;
  }),
}));

vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => ({
    readyAgentIds: new Set(["goose"]),
    agentReadiness: new Map([["goose", "ready"]]),
    agentChecks: new Map(),
    loading: false,
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { AgentBuilderRail } from "../AgentBuilderRail";
import { usePersonaSource } from "@/features/agents/hooks/usePersonaSource";
import { promoteDraft } from "@/features/agents/lib/agentBuilderSession";
import { useAvatarLibrary } from "@/features/agents/hooks/useAvatarLibrary";
import type { AgentSourceEntry } from "@/shared/api/agents";

type UsePersonaSourceReturn = ReturnType<typeof usePersonaSource>;

const baseSource: AgentSourceEntry = {
  type: "agent",
  path: "/Users/x/.agents/agents/draft-1.md",
  name: "Untitled agent",
  description: "Draft",
  content: "Draft in progress.",
  properties: { draft: true, builderSessionId: "s1" },
  writable: true,
} as AgentSourceEntry;

function mockHook(overrides: Partial<UsePersonaSourceReturn> = {}) {
  const result: UsePersonaSourceReturn = {
    data: baseSource,
    isLoading: false,
    error: null,
    update: vi.fn(),
    saveStatus: "saved",
    saveNow: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
  vi.mocked(usePersonaSource).mockReturnValue(result);
  return result;
}

describe("AgentBuilderRail", () => {
  beforeEach(() => {
    vi.mocked(usePersonaSource).mockReset();
    vi.mocked(promoteDraft).mockReset();
    toastMocks.success.mockReset();
    toastMocks.error.mockReset();
    agentTelemetryMocks.trackAgentCreateCompleted.mockReset();
    agentTelemetryMocks.trackAgentEditCompleted.mockReset();
    agentTelemetryMocks.trackAgentDeleteCompleted.mockReset();
    vi.mocked(useAvatarLibrary).mockReturnValue({
      catalog: null,
      userAvatarIds: [],
      userAvatarMediaById: {},
      cachedAvatarMediaById: {},
      loading: false,
      cacheChecking: false,
      error: false,
      errorCode: null,
      mediaError: false,
      mediaErrorCode: null,
      retryCatalog: vi.fn(),
      retryMedia: vi.fn(),
    });
  });

  it("renders the 'New agent' header when the source still has the placeholder name", () => {
    mockHook();
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );
    expect(
      screen.getByRole("heading", { name: /new agent/i }),
    ).toBeInTheDocument();
  });

  it("renders the full-page builder and expands chat", () => {
    mockHook();
    const onExpandChat = vi.fn();
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
        fullPage
        onExpandChat={onExpandChat}
      />,
    );

    expect(screen.getByTestId("agent-builder-rail")).toHaveAttribute(
      "data-full-page",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: /show chat/i }));
    expect(onExpandChat).toHaveBeenCalledTimes(1);
  });

  it("renders the source's real name when changed", () => {
    mockHook({ data: { ...baseSource, name: "Snark" } });
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );
    expect(screen.getByRole("heading", { name: /snark/i })).toBeInTheDocument();
  });

  it("calls update() when the name field changes", () => {
    const { update } = mockHook();
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );
    fireEvent.change(screen.getByLabelText(/agent name/i), {
      target: { value: "Snark" },
    });
    expect(update).toHaveBeenCalledWith({ name: "Snark" });
  });

  it("calls update() when the instructions textarea changes", () => {
    const { update } = mockHook();
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );
    fireEvent.change(screen.getByLabelText(/agent instructions/i), {
      target: { value: "Be snarky." },
    });
    expect(update).toHaveBeenCalledWith({ content: "Be snarky." });
  });

  it("allows an incomplete draft to be saved when leaving", async () => {
    const saveNow = vi.fn().mockResolvedValue(true);
    mockHook({ saveNow });
    let saveDraft: (() => boolean | Promise<boolean>) | null = null;
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
        onSaveDraftHandlerChange={(handler) => {
          saveDraft = handler;
        }}
      />,
    );

    expect(screen.getByLabelText(/description/i)).toHaveValue("");
    await waitFor(() => expect(saveDraft).not.toBeNull());
    const registeredSave = saveDraft as unknown as () => Promise<boolean>;
    await expect(registeredSave()).resolves.toBe(true);
    expect(saveNow).toHaveBeenCalledOnce();
  });

  it("calls update() when the description field changes", () => {
    const { update } = mockHook();
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );
    fireEvent.change(screen.getByLabelText(/description/i), {
      target: { value: "Catches bugs before you ship them." },
    });
    expect(update).toHaveBeenCalledWith({
      description: "Catches bugs before you ship them.",
    });
  });

  it("treats the placeholder draft description as empty in the field", () => {
    mockHook({ data: { ...baseSource, description: "Draft" } });
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );
    expect(screen.getByLabelText(/description/i)).toHaveValue("");
  });

  it("renders the placeholder draft body as muted placeholder text", () => {
    mockHook();
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );

    const textarea = screen.getByLabelText(/agent instructions/i);
    expect(textarea).toHaveValue("");
    expect(textarea).toHaveAttribute("placeholder", "Draft in progress.");
  });

  it("does not render the custom avatar URL field", () => {
    mockHook();
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );

    expect(screen.queryByLabelText(/custom avatar url/i)).toBeNull();
    expect(
      screen.getByRole("button", { name: /select avatar/i }),
    ).toBeInTheDocument();
  });

  it("only marks an empty description invalid after a save attempt", () => {
    const { saveNow } = mockHook({
      data: {
        ...baseSource,
        name: "Reviewer",
        content: "Review code carefully.",
        properties: {
          ...baseSource.properties,
          avatar: "app-avatar:gloopy-1",
        },
      },
    });
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );

    const saveButton = screen.getByRole("button", { name: /save changes/i });
    const description = screen.getByLabelText(/description/i);

    expect(saveButton).not.toHaveAttribute("aria-disabled");
    expect(description).toBeRequired();
    expect(description).toHaveAttribute("aria-invalid", "false");

    fireEvent.click(saveButton);

    expect(description).toHaveAttribute("aria-invalid", "true");
    expect(saveNow).not.toHaveBeenCalled();
    expect(promoteDraft).not.toHaveBeenCalled();
  });

  it("keeps save unavailable when another required field is missing", () => {
    mockHook({
      data: {
        ...baseSource,
        description: "Reviews code carefully.",
        content: "Review code carefully.",
        properties: {
          ...baseSource.properties,
          avatar: "app-avatar:gloopy-1",
        },
      },
    });
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );

    expect(
      screen.getByRole("button", { name: /save changes/i }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("does not persist a default avatar when the draft opens", async () => {
    const { update } = mockHook();
    vi.mocked(useAvatarLibrary).mockReturnValue({
      catalog: {
        schemaVersion: 1,
        catalogVersion: "v1",
        collections: [
          {
            id: "gloopies",
            label: "Gloopies",
            coverAvatarId: "gloopy-1",
            avatarIds: ["gloopy-1"],
          },
        ],
        assets: [
          {
            id: "gloopy-1",
            label: "Gloopy 1",
            collectionId: "gloopies",
            variants: {
              webm: {
                path: "gloopy-1.webm",
                mimeType: "video/webm",
                byteSize: 1,
                sha256:
                  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              },
              hevc: {
                path: "gloopy-1.mov",
                mimeType: "video/quicktime",
                byteSize: 1,
                sha256:
                  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              },
            },
          },
        ],
      },
      userAvatarIds: [],
      userAvatarMediaById: {},
      cachedAvatarMediaById: {
        "gloopy-1": {
          catalogVersion: "v1",
          media: { src: "/cached/gloopy-1.webm", mediaType: "video" },
        },
      },
      loading: false,
      cacheChecking: false,
      error: false,
      errorCode: null,
      mediaError: false,
      mediaErrorCode: null,
      retryCatalog: vi.fn(),
      retryMedia: vi.fn(),
    });

    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /select avatar/i }),
      ).toBeInTheDocument();
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("accepts an avatar into the working buffer without saving other edits", async () => {
    vi.useFakeTimers();
    try {
      const { update, saveNow } = mockHook();
      vi.mocked(useAvatarLibrary).mockReturnValue({
        catalog: {
          schemaVersion: 1,
          catalogVersion: "v1",
          collections: [
            {
              id: "gloopies",
              label: "Gloopies",
              coverAvatarId: "gloopy-1",
              avatarIds: ["gloopy-1"],
            },
          ],
          assets: [
            {
              id: "gloopy-1",
              label: "Gloopy 1",
              collectionId: "gloopies",
              variants: {
                webm: {
                  path: "gloopy-1.webm",
                  mimeType: "video/webm",
                  byteSize: 1,
                  sha256: "a".repeat(64),
                },
                hevc: {
                  path: "gloopy-1.mov",
                  mimeType: "video/quicktime",
                  byteSize: 1,
                  sha256: "b".repeat(64),
                },
              },
            },
          ],
        },
        cachedAvatarMediaById: {
          "gloopy-1": {
            catalogVersion: "v1",
            media: { src: "/cached/gloopy-1.webm", mediaType: "video" },
          },
        },
        userAvatarIds: [],
        userAvatarMediaById: {},
        loading: false,
        cacheChecking: false,
        error: false,
        errorCode: null,
        mediaError: false,
        mediaErrorCode: null,
        retryCatalog: vi.fn(),
        retryMedia: vi.fn(),
      });
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 1200,
        bottom: 800,
        width: 1200,
        height: 800,
        toJSON: () => ({}),
      } as DOMRect);

      renderWithProviders(
        <AgentBuilderRail
          sessionId="s1"
          targetAgentPath={baseSource.path}
          targetAgentSlug="draft-1"
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: /select avatar/i }));
      fireEvent.click(screen.getAllByRole("button", { name: "Gloopy 1" })[0]);
      fireEvent.click(screen.getByRole("button", { name: /^select$/i }));
      await act(async () => {});

      expect(update).toHaveBeenCalledWith({
        properties: { avatar: "app-avatar:gloopy-1" },
      });
      expect(saveNow).not.toHaveBeenCalled();
      act(() => vi.runAllTimers());
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens avatar choices in the collection canvas", () => {
    mockHook();
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );

    expect(
      screen.queryByTestId("avatar-collection-overlay"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /select avatar/i }));
    expect(screen.getByTestId("avatar-collection-overlay")).toBeInTheDocument();
  });

  it("promotes an otherwise-complete draft without provider or model overrides", async () => {
    const { saveNow } = mockHook({
      data: {
        ...baseSource,
        name: "Snark",
        description: "A sharp, witty agent.",
        content: "Be snarky.",
        properties: {
          draft: true,
          builderSessionId: "s1",
          avatar: "app-avatar:gloopy-1",
        },
      },
    });
    vi.mocked(promoteDraft).mockResolvedValue({
      ...baseSource,
      name: "Snark",
      description: "A sharp, witty agent.",
      content: "Be snarky.",
      properties: {
        avatar: "app-avatar:gloopy-1",
      },
    });

    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );

    const saveButton = screen.getByRole("button", { name: /save changes/i });
    expect(saveButton).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(saveNow).toHaveBeenCalled();
      expect(promoteDraft).toHaveBeenCalledWith("s1");
    });
  });

  it("promotes the draft when save changes is clicked with complete fields", async () => {
    const { saveNow } = mockHook({
      data: {
        ...baseSource,
        name: "Snark",
        description: "A sharp, witty agent.",
        content: "Be snarky.",
        properties: {
          draft: true,
          builderSessionId: "s1",
          avatar: "app-avatar:gloopy-1",
          provider: "openai",
          model: "gpt-5",
        },
      },
    });
    const promotedSource = {
      ...baseSource,
      path: "/Users/x/.agents/agents/snark.md",
      name: "Snark",
      description: "A sharp, witty agent.",
      content: "Be snarky.",
      properties: {
        avatar: "app-avatar:gloopy-1",
        provider: "openai",
        model: "gpt-5",
      },
    };
    vi.mocked(promoteDraft).mockResolvedValue(promotedSource);
    const onDraftPromoted = vi.fn();

    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
        onDraftPromoted={onDraftPromoted}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(saveNow).toHaveBeenCalled();
      expect(promoteDraft).toHaveBeenCalledWith("s1");
      expect(onDraftPromoted).toHaveBeenCalledWith(promotedSource);
    });
    expect(agentTelemetryMocks.trackAgentCreateCompleted).toHaveBeenCalledTimes(
      1,
    );
    expect(agentTelemetryMocks.trackAgentCreateCompleted).toHaveBeenCalledWith({
      provider: "openai",
      model: "gpt-5",
    });
    expect(agentTelemetryMocks.trackAgentEditCompleted).not.toHaveBeenCalled();
  });

  it("does not promote when flushing rail edits fails", async () => {
    const { saveNow } = mockHook({
      data: {
        ...baseSource,
        name: "Snark",
        description: "A sharp, witty agent.",
        content: "Be snarky.",
        properties: {
          draft: true,
          builderSessionId: "s1",
          avatar: "app-avatar:gloopy-1",
          provider: "openai",
          model: "gpt-5",
        },
      },
      saveStatus: "error",
      error: "load",
      saveNow: vi.fn().mockResolvedValue(false),
    });

    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /save changes|retry save/i }),
    );

    await waitFor(() => {
      expect(saveNow).toHaveBeenCalled();
    });
    expect(promoteDraft).not.toHaveBeenCalled();
  });

  it("allows existing agents to save without draft-only required metadata", async () => {
    const { saveNow } = mockHook({
      data: {
        ...baseSource,
        name: "Code Reviewer",
        description: "Reviews code for correctness.",
        content: "",
        properties: {},
      },
    });
    vi.mocked(promoteDraft).mockResolvedValue({
      ...baseSource,
      name: "Code Reviewer",
      content: "",
      properties: {},
    });

    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="code-reviewer"
      />,
    );

    const button = screen.getByRole("button", { name: /save changes/i });
    expect(button).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(button);

    await waitFor(() => {
      expect(saveNow).toHaveBeenCalled();
      expect(promoteDraft).toHaveBeenCalledWith("s1");
    });
  });

  describe("berd_agent Edit Completed", () => {
    const existingAgentSource: AgentSourceEntry = {
      ...baseSource,
      path: "/Users/x/.agents/agents/code-reviewer.md",
      name: "Code Reviewer",
      description: "Reviews code for correctness.",
      content: "Review code carefully.",
      properties: { provider: "openai", model: "gpt-5" },
    };

    function lastPersonaSourceOptions() {
      return vi.mocked(usePersonaSource).mock.calls.at(-1)?.[1];
    }

    // A saveNow double that behaves like the real flush persisting
    // `persisted`: it reports the write through the rail's onWritePersisted
    // before resolving, exactly as usePersonaSource does.
    function persistingSaveNow(persisted: AgentSourceEntry) {
      return vi.fn().mockImplementation(async () => {
        lastPersonaSourceOptions()?.onWritePersisted?.(persisted);
        return true;
      });
    }

    function renderExistingAgentRail() {
      return renderWithProviders(
        <AgentBuilderRail
          sessionId="s1"
          targetAgentPath={existingAgentSource.path}
          targetAgentSlug="code-reviewer"
        />,
      );
    }

    it("does not fire for a no-op Save with nothing to persist", async () => {
      const { saveNow } = mockHook({ data: existingAgentSource });
      vi.mocked(promoteDraft).mockResolvedValue(existingAgentSource);
      renderExistingAgentRail();

      fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

      await waitFor(() => {
        expect(saveNow).toHaveBeenCalled();
        expect(promoteDraft).toHaveBeenCalledWith("s1");
      });
      expect(
        agentTelemetryMocks.trackAgentEditCompleted,
      ).not.toHaveBeenCalled();
      expect(
        agentTelemetryMocks.trackAgentCreateCompleted,
      ).not.toHaveBeenCalled();
    });

    it("fires once from the persisted write when a real edit saves", async () => {
      const persisted = {
        ...existingAgentSource,
        name: "Code Reviewer Deluxe",
      };
      mockHook({
        data: existingAgentSource,
        saveNow: persistingSaveNow(persisted),
      });
      vi.mocked(promoteDraft).mockResolvedValue(persisted);
      renderExistingAgentRail();

      fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

      await waitFor(() => {
        expect(promoteDraft).toHaveBeenCalledWith("s1");
      });
      expect(agentTelemetryMocks.trackAgentEditCompleted).toHaveBeenCalledTimes(
        1,
      );
      expect(agentTelemetryMocks.trackAgentEditCompleted).toHaveBeenCalledWith({
        provider: "openai",
        model: "gpt-5",
      });
      expect(
        agentTelemetryMocks.trackAgentCreateCompleted,
      ).not.toHaveBeenCalled();
    });

    it("still fires when the post-save source lookup comes back empty", async () => {
      const persisted = {
        ...existingAgentSource,
        name: "Code Reviewer Deluxe",
      };
      const saveNow = persistingSaveNow(persisted);
      mockHook({ data: existingAgentSource, saveNow });
      vi.mocked(promoteDraft).mockResolvedValue(null);
      renderExistingAgentRail();

      fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

      await waitFor(() => {
        expect(saveNow).toHaveBeenCalled();
        expect(promoteDraft).toHaveBeenCalledWith("s1");
      });
      expect(agentTelemetryMocks.trackAgentEditCompleted).toHaveBeenCalledTimes(
        1,
      );
      expect(agentTelemetryMocks.trackAgentEditCompleted).toHaveBeenCalledWith({
        provider: "openai",
        model: "gpt-5",
      });
    });

    it("tracks non-draft persisted writes and stays silent for draft writes", () => {
      mockHook();
      renderWithProviders(
        <AgentBuilderRail
          sessionId="s1"
          targetAgentPath={baseSource.path}
          targetAgentSlug="draft-1"
        />,
      );
      const options = lastPersonaSourceOptions();

      // A draft write is the create flow's incremental auto-save.
      options?.onWritePersisted?.(baseSource);
      expect(
        agentTelemetryMocks.trackAgentEditCompleted,
      ).not.toHaveBeenCalled();

      // A non-draft write is a real edit no matter which caller ran saveNow
      // (Save button, leave-builder Keep, builder close).
      options?.onWritePersisted?.(existingAgentSource);
      expect(agentTelemetryMocks.trackAgentEditCompleted).toHaveBeenCalledTimes(
        1,
      );
      expect(agentTelemetryMocks.trackAgentEditCompleted).toHaveBeenCalledWith({
        provider: "openai",
        model: "gpt-5",
      });
    });
  });

  it("does not show a back button in the agent editor", () => {
    mockHook({
      data: {
        ...baseSource,
        name: "Code Reviewer",
        properties: {},
      },
    });

    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="code-reviewer"
      />,
    );

    expect(
      screen.queryByRole("button", { name: /back to agent/i }),
    ).not.toBeInTheDocument();
  });

  it("shows a close affordance only when the source is a draft", () => {
    mockHook({
      data: {
        ...baseSource,
        properties: { draft: false },
      },
    });
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="existing"
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /close agent builder/i }),
    ).toBeNull();
  });

  it("invokes onClose when the draft close button is clicked", () => {
    const onClose = vi.fn();
    mockHook();
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
        onClose={onClose}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /close agent builder/i }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders a Loading state while the source is loading", () => {
    mockHook({ data: null, isLoading: true });
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );
    expect(screen.getByText(/loading agent/i)).toBeInTheDocument();
  });

  it("renders a preparing state while the draft target is pending", () => {
    mockHook({ data: null, error: "missing", isLoading: false });
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={null}
        targetAgentSlug={null}
      />,
    );

    expect(screen.getByText(/preparing draft/i)).toBeInTheDocument();
    expect(screen.queryByText(/draft missing/i)).not.toBeInTheDocument();
    expect(vi.mocked(usePersonaSource).mock.calls.at(-1)?.[0]).toBeNull();
  });

  it("renders a retry state when preparing the draft target fails", () => {
    const onRecoverMissingDraft = vi.fn();
    mockHook({ data: null, error: "missing", isLoading: false });
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={null}
        targetAgentSlug={null}
        draftState="failed"
        onRecoverMissingDraft={onRecoverMissingDraft}
      />,
    );

    expect(screen.getByText(/couldn't prepare draft/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRecoverMissingDraft).toHaveBeenCalledTimes(1);
  });

  it("renders a 'Draft missing' state when the source can't be found", () => {
    mockHook({ data: null, error: "missing", isLoading: false });
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );
    expect(screen.getByText(/draft missing/i)).toBeInTheDocument();
  });

  it("automatically requests recovery when a builder draft source is missing", async () => {
    const onRecoverMissingDraft = vi.fn();
    mockHook({ data: null, error: "missing", isLoading: false });

    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
        onRecoverMissingDraft={onRecoverMissingDraft}
      />,
    );

    await waitFor(() => {
      expect(onRecoverMissingDraft).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText(/draft missing/i)).not.toBeInTheDocument();
    expect(screen.getByText(/loading agent/i)).toBeInTheDocument();
  });

  it("shows missing after automatic draft recovery fails", async () => {
    const onRecoverMissingDraft = vi.fn().mockRejectedValue(new Error("nope"));
    mockHook({ data: null, error: "missing", isLoading: false });

    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
        onRecoverMissingDraft={onRecoverMissingDraft}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/draft missing/i)).toBeInTheDocument();
    });
  });

  it("opens the collection canvas overlay instead of replacing the form", () => {
    mockHook();
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );

    expect(
      screen.queryByTestId("avatar-collection-overlay"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /select avatar/i }));

    // The takeover renders instead of swapping the rail body: the form stays
    // mounted underneath and the inline picker heading never appears.
    expect(screen.getByTestId("avatar-collection-overlay")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /choose an avatar/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText(/agent name/i)).toBeInTheDocument();
  });

  it("closes the collection canvas overlay back to the untouched form", () => {
    vi.useFakeTimers();
    try {
      mockHook();
      renderWithProviders(
        <AgentBuilderRail
          sessionId="s1"
          targetAgentPath={baseSource.path}
          targetAgentSlug="draft-1"
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: /select avatar/i }));
      fireEvent.click(screen.getByRole("button", { name: /^close$/i }));

      // The overlay plays its exit animation before handing control back.
      expect(
        screen.getByTestId("avatar-collection-overlay"),
      ).toBeInTheDocument();
      act(() => {
        vi.runAllTimers();
      });

      expect(
        screen.queryByTestId("avatar-collection-overlay"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /select avatar/i }),
      ).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders an 'Invalid frontmatter' state when the source can't be parsed", () => {
    mockHook({ data: null, error: "parse", isLoading: false });
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );
    expect(screen.getByText(/invalid frontmatter/i)).toBeInTheDocument();
  });
});
