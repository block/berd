import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";

vi.mock("@/features/agents/hooks/usePersonaSource", () => ({
  usePersonaSource: vi.fn(),
}));

vi.mock("@/features/agents/lib/agentBuilderSession", () => ({
  discardDraftAgentSession: vi.fn(),
  promoteDraft: vi.fn(),
  fileStem: (path: string) => path.split("/").pop()?.replace(/\.md$/, ""),
  isPlaceholderAgentName: (name: string) =>
    name === "Untitled agent" || name.startsWith("Untitled agent "),
  PLACEHOLDER_AGENT_NAME: "Untitled agent",
  PLACEHOLDER_AGENT_BODY: "Draft in progress.",
}));

vi.mock("@/features/agents/hooks/useAvatarLibrary", () => ({
  useAvatarLibrary: vi.fn(() => ({
    catalog: null,
    cachedAvatarMediaById: {},
    loading: false,
    cacheChecking: false,
    error: false,
    downloadingCollectionId: null,
    failedCollectionIds: new Set<string>(),
    retryCatalog: vi.fn(),
    openCollection: vi.fn(),
    isCollectionCached: () => false,
  })),
}));

vi.mock("@/features/agents/stores/agentStore", () => ({
  useAgentStore: vi.fn((selector?: (state: unknown) => unknown) => {
    const state = { providers: [], personas: [] };
    return selector ? selector(state) : state;
  }),
}));

vi.mock("@/features/providers/hooks/useProviderInventory", () => ({
  useProviderInventory: () => ({
    getEntry: vi.fn(() => undefined),
    getModelsForAgent: vi.fn(() => []),
  }),
}));

import { AgentBuilderRail } from "../AgentBuilderRail";
import { usePersonaSource } from "@/features/agents/hooks/usePersonaSource";
import {
  discardDraftAgentSession,
  promoteDraft,
} from "@/features/agents/lib/agentBuilderSession";
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
    vi.mocked(discardDraftAgentSession).mockReset();
    vi.mocked(promoteDraft).mockReset();
    vi.mocked(useAvatarLibrary).mockReturnValue({
      catalog: null,
      cachedAvatarMediaById: {},
      loading: false,
      cacheChecking: false,
      error: false,
      downloadingCollectionId: null,
      failedCollectionIds: new Set<string>(),
      retryCatalog: vi.fn(),
      openCollection: vi.fn(),
      isCollectionCached: () => false,
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

  it("disables save changes until required fields are complete", () => {
    mockHook();
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );

    expect(
      screen.getByRole("button", { name: /save changes/i }),
    ).toBeDisabled();
    expect(screen.getByText(/required:/i)).toHaveTextContent(/avatar/i);
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
      cachedAvatarMediaById: {
        "gloopy-1": {
          catalogVersion: "v1",
          media: { src: "/cached/gloopy-1.webm", mediaType: "video" },
        },
      },
      loading: false,
      cacheChecking: false,
      error: false,
      downloadingCollectionId: null,
      failedCollectionIds: new Set<string>(),
      retryCatalog: vi.fn(),
      openCollection: vi.fn(),
      isCollectionCached: () => true,
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

  it("shows avatar choices only after the selected avatar is clicked", () => {
    mockHook();
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );

    expect(
      screen.queryByRole("heading", { name: /choose avatar/i }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /select avatar/i }));

    expect(
      screen.getByRole("heading", { name: /choose avatar/i }),
    ).toBeInTheDocument();
  });

  it("promotes the draft when save changes is clicked with complete fields", async () => {
    const { saveNow } = mockHook({
      data: {
        ...baseSource,
        name: "Snark",
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
    vi.mocked(promoteDraft).mockResolvedValue({
      ...baseSource,
      name: "Snark",
      content: "Be snarky.",
      properties: {
        avatar: "app-avatar:gloopy-1",
        provider: "openai",
        model: "gpt-5",
      },
    });
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
      expect(onDraftPromoted).toHaveBeenCalled();
    });
  });

  it("does not promote when flushing rail edits fails", async () => {
    const { saveNow } = mockHook({
      data: {
        ...baseSource,
        name: "Snark",
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
    expect(button).not.toBeDisabled();
    fireEvent.click(button);

    await waitFor(() => {
      expect(saveNow).toHaveBeenCalled();
      expect(promoteDraft).toHaveBeenCalledWith("s1");
    });
  });

  it("shows a Discard affordance only when the source is a draft", () => {
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
      />,
    );
    expect(screen.queryByRole("button", { name: /discard/i })).toBeNull();
  });

  it("invokes discardDraftAgentSession when Discard is clicked", () => {
    mockHook();
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /discard/i }));
    expect(discardDraftAgentSession).toHaveBeenCalledWith("s1");
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
