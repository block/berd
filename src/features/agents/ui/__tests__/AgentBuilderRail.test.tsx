import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { renderWithProviders } from "@/test/render";

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: toastMocks,
}));

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
}));

vi.mock("@/features/agents/hooks/useAvatarLibrary", () => ({
  useAvatarLibrary: vi.fn(() => ({
    catalog: null,
    cachedAvatarMediaById: {},
    loading: false,
    cacheChecking: false,
    error: false,
    errorCode: null,
    downloadingCollectionIds: new Set<string>(),
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
import {
  resetGloopieGenerationStoreForTests,
  useGloopieGenerationStore,
} from "@/features/agents/stores/gloopieGenerationStore";
import {
  EXPERIMENT_PREFERENCES_STORAGE_KEY,
  EXPERIMENT_PREFERENCES_STORAGE_VERSION,
} from "@/features/experiments/experimentPreferences";
import {
  AVATAR_COLLECTION_PAGE_EXPERIMENT_ID,
  GLOOPIE_AVATAR_CREATOR_EXPERIMENT_ID,
} from "@/features/experiments/experimentDefinitions";
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

function setExperimentOverrides(overrides: Record<string, boolean>) {
  localStorage.setItem(
    EXPERIMENT_PREFERENCES_STORAGE_KEY,
    JSON.stringify({
      version: EXPERIMENT_PREFERENCES_STORAGE_VERSION,
      experiments: Object.fromEntries(
        Object.entries(overrides).map(([id, enabled]) => [id, { enabled }]),
      ),
    }),
  );
}

// Most rail tests exercise the classic inline picker, so the collection
// canvas experiment (auto-enabled in dev/test) is pinned off by default.
// Overlay-specific tests re-enable it explicitly.
function disableAvatarCollectionOverlay() {
  setExperimentOverrides({ [AVATAR_COLLECTION_PAGE_EXPERIMENT_ID]: false });
}

function disableGloopieExperiment() {
  setExperimentOverrides({
    [GLOOPIE_AVATAR_CREATOR_EXPERIMENT_ID]: false,
    [AVATAR_COLLECTION_PAGE_EXPERIMENT_ID]: false,
  });
}

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
    localStorage.removeItem(EXPERIMENT_PREFERENCES_STORAGE_KEY);
    disableAvatarCollectionOverlay();
    resetGloopieGenerationStoreForTests();
    vi.mocked(usePersonaSource).mockReset();
    vi.mocked(promoteDraft).mockReset();
    toastMocks.success.mockReset();
    toastMocks.error.mockReset();
    vi.mocked(useAvatarLibrary).mockReturnValue({
      catalog: null,
      cachedAvatarMediaById: {},
      loading: false,
      cacheChecking: false,
      error: false,
      errorCode: null,
      downloadingCollectionIds: new Set<string>(),
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
    ).toHaveAttribute("aria-disabled", "true");
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
      errorCode: null,
      downloadingCollectionIds: new Set<string>(),
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
      screen.queryByRole("heading", { name: /choose an avatar/i }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /select avatar/i }));

    expect(
      screen.getByRole("heading", { name: /choose an avatar/i }),
    ).toBeInTheDocument();
  });

  it("keeps gloopie generation available while continuing agent setup", () => {
    mockHook();
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /select avatar/i }));
    fireEvent.click(screen.getByRole("button", { name: /create your own/i }));
    fireEvent.change(screen.getByLabelText(/what should your gloopie be/i), {
      target: { value: "teapot" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create gloopie/i }));
    fireEvent.click(screen.getByRole("button", { name: /back/i }));

    expect(screen.getByLabelText(/agent name/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /creating your gloopie/i }),
    ).toBeInTheDocument();
    expect(screen.queryByAltText(/avatar preview/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /save changes/i }),
    ).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(
      screen.getByRole("button", { name: /creating your gloopie/i }),
    );
    expect(
      screen.getByRole("heading", { name: /continue setting up agent/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/creating your gloopie/i)).toBeInTheDocument();
  });

  it("announces a backgrounded generation finishing with a toast", () => {
    mockHook();
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /select avatar/i }));
    fireEvent.click(screen.getByRole("button", { name: /create your own/i }));
    fireEvent.change(screen.getByLabelText(/what should your gloopie be/i), {
      target: { value: "teapot" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create gloopie/i }));
    // Backgrounding is what arms the toast: the user is no longer looking at
    // the creator, so the phase change has to reach them some other way.
    fireEvent.click(
      screen.getByRole("button", { name: /continue setting up agent/i }),
    );
    expect(toastMocks.success).not.toHaveBeenCalled();

    act(() => {
      useGloopieGenerationStore.setState((state) => ({
        jobs: {
          ...state.jobs,
          s1: {
            ...state.jobs.s1,
            phase: "choosing",
            options: [{ id: "a", avatarRef: "user-avatar:a" }],
          },
        },
      }));
    });

    expect(toastMocks.success).toHaveBeenCalledWith(
      "Your gloopie options are ready.",
      expect.objectContaining({ action: expect.anything() }),
    );
  });

  it("announces a backgrounded generation failing with a toast", () => {
    mockHook();
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /select avatar/i }));
    fireEvent.click(screen.getByRole("button", { name: /create your own/i }));
    fireEvent.change(screen.getByLabelText(/what should your gloopie be/i), {
      target: { value: "teapot" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create gloopie/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /continue setting up agent/i }),
    );

    act(() => {
      useGloopieGenerationStore.setState((state) => ({
        jobs: {
          ...state.jobs,
          s1: { ...state.jobs.s1, phase: "error", errorCode: "unavailable" },
        },
      }));
    });

    expect(toastMocks.error).toHaveBeenCalledWith(
      "We couldn't finish your gloopie.",
      expect.objectContaining({ action: expect.anything() }),
    );
  });

  it("shows the full gloopie state instead of the status card in full-page mode", () => {
    mockHook();
    useGloopieGenerationStore.setState({
      jobs: {
        s1: {
          phase: "animating",
          object: "teapot",
          options: [{ id: "choice", avatarRef: "user-avatar:choice" }],
          chosenOptionId: "choice",
          resultAvatarRef: null,
          errorCode: null,
          attemptId: 42,
        },
      },
    });

    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
        fullPage
      />,
    );

    expect(screen.getByText(/bringing it to life/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /continue setting up agent/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^cancel$/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /bringing your gloopie to life/i }),
    ).not.toBeInTheDocument();
  });

  it("returns from the full-page gloopie prompt to avatar choices", () => {
    mockHook();
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
        fullPage
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /select avatar/i }));
    fireEvent.click(screen.getByRole("button", { name: /create your own/i }));

    expect(
      screen.getByRole("button", { name: /back to avatar choices/i }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /back to avatar choices/i }),
    );

    expect(
      screen.getByRole("heading", { name: /choose an avatar/i }),
    ).toBeInTheDocument();
    const createYourOwn = screen.getByRole("button", {
      name: /create your own/i,
    });
    expect(createYourOwn).toBeInTheDocument();

    fireEvent.click(createYourOwn);
    expect(screen.getByLabelText(/what should your gloopie be/i)).toHaveValue(
      "",
    );
  });

  it("preserves a full-page gloopie prompt when navigating back and forth", () => {
    mockHook();
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
        fullPage
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /select avatar/i }));
    fireEvent.click(screen.getByRole("button", { name: /create your own/i }));
    fireEvent.change(screen.getByLabelText(/what should your gloopie be/i), {
      target: { value: "teapot" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /back to avatar choices/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /create your own/i }));

    expect(screen.getByLabelText(/what should your gloopie be/i)).toHaveValue(
      "teapot",
    );
  });

  it("keeps a failed prompt editable in the full-page creator", () => {
    mockHook();
    useGloopieGenerationStore.setState({
      jobs: {
        s1: {
          phase: "error",
          object: "blocked prompt",
          options: [],
          chosenOptionId: null,
          resultAvatarRef: null,
          errorCode: "contentBlocked",
          attemptId: 42,
        },
      },
    });

    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
        fullPage
      />,
    );

    expect(screen.getByLabelText(/what should your gloopie be/i)).toHaveValue(
      "blocked prompt",
    );
    expect(
      screen.getByText(/that description couldn't be used/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /try again/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /discard/i }),
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/what should your gloopie be/i), {
      target: { value: "friendly teapot" },
    });
    expect(screen.getByLabelText(/what should your gloopie be/i)).toHaveValue(
      "friendly teapot",
    );
    expect(
      screen.getByRole("button", { name: /try again/i }),
    ).toBeInTheDocument();
  });

  it("restores session-scoped gloopie work after the rail remounts", () => {
    mockHook();
    useGloopieGenerationStore.setState({
      jobs: {
        s1: {
          phase: "animating",
          object: "teapot",
          options: [{ id: "choice", avatarRef: "user-avatar:choice" }],
          chosenOptionId: "choice",
          resultAvatarRef: null,
          errorCode: null,
          attemptId: 42,
        },
      },
    });

    const view = renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );
    expect(
      screen.getByRole("button", { name: /bringing your gloopie to life/i }),
    ).toBeInTheDocument();

    view.unmount();
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );
    expect(
      screen.getByRole("button", { name: /bringing your gloopie to life/i }),
    ).toBeInTheDocument();
  });

  it("explains a failure with the same copy in the status card and the creator", () => {
    mockHook();
    // Three surfaces describe this failure. If any one of them reimplements
    // the errorCode -> copy mapping, this drifts and the user gets a
    // different explanation depending on where they look.
    useGloopieGenerationStore.setState({
      jobs: {
        s1: {
          phase: "error",
          object: "teapot",
          options: [],
          chosenOptionId: null,
          resultAvatarRef: null,
          errorCode: "contentBlocked",
          attemptId: 9,
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

    const blockedCopy =
      /that description couldn't be used\. try describing a physical object or character\./i;
    // The rail's status card explains the specific failure, not a generic one.
    expect(screen.getByText(blockedCopy)).toBeInTheDocument();
    expect(
      screen.queryByText(/couldn't finish that request/i),
    ).not.toBeInTheDocument();

    // Reopening the creator must explain it identically.
    fireEvent.click(
      screen.getByRole("button", { name: /we couldn't finish your gloopie/i }),
    );
    expect(screen.getByText(blockedCopy)).toBeInTheDocument();
    expect(
      screen.queryByText(/couldn't finish that request/i),
    ).not.toBeInTheDocument();
  });

  it("abandons in-flight gloopie media when the experiment is turned off", () => {
    // A generation was running when the experiment got switched off. The gated
    // phase now reads "prompt", so nothing will ever surface these files —
    // they have to be released rather than stranded on disk.
    useGloopieGenerationStore.setState({
      jobs: {
        s1: {
          phase: "choosing",
          object: "teapot",
          options: [
            { id: "a", avatarRef: "user-avatar:a" },
            { id: "b", avatarRef: "user-avatar:b" },
          ],
          chosenOptionId: null,
          resultAvatarRef: null,
          errorCode: null,
          attemptId: 11,
        },
      },
    });
    disableGloopieExperiment();
    mockHook();

    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );

    const job = useGloopieGenerationStore.getState().jobs.s1;
    expect(job?.phase).toBe("prompt");
    expect(job?.options).toEqual([]);
  });

  it("keeps a committed gloopie avatar when the experiment is turned off", () => {
    // The mirror of the case above: an avatar the user already committed must
    // survive the same cleanup path, or turning the experiment off would strip
    // a saved agent's avatar.
    disableGloopieExperiment();
    const { update } = mockHook({
      data: {
        ...baseSource,
        properties: {
          ...baseSource.properties,
          avatar: "user-avatar:committed",
        },
      } as AgentSourceEntry,
    });

    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );

    // A resolved job reports no work, so cleanup must not run and must not
    // rewrite the agent's avatar.
    expect(update).not.toHaveBeenCalled();
    expect(useGloopieGenerationStore.getState().jobs.s1).toBeUndefined();
  });

  it("blocks saving while a gloopie is still animating", async () => {
    const completeSource = {
      ...baseSource,
      name: "Teapot",
      content: "Be helpful.",
      properties: {
        draft: true,
        builderSessionId: "s1",
        avatar: "app-avatar:old",
        provider: "openai",
        model: "gpt-5",
      },
    };
    // Every required field is satisfied, so the animating gloopie is the only
    // thing that can disable save here.
    mockHook({ data: completeSource });
    useGloopieGenerationStore.setState({
      jobs: {
        s1: {
          phase: "animating",
          object: "teapot",
          options: [{ id: "choice", avatarRef: "user-avatar:choice" }],
          chosenOptionId: "choice",
          resultAvatarRef: null,
          errorCode: null,
          attemptId: 42,
        },
      },
    });

    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="teapot"
        onDraftPromoted={vi.fn()}
      />,
    );

    const saveButton = screen.getByRole("button", { name: /save changes/i });
    expect(saveButton).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByText(/still rendering your gloopie/i),
    ).toBeInTheDocument();

    fireEvent.click(saveButton);
    await waitFor(() => {
      expect(promoteDraft).not.toHaveBeenCalled();
    });
  });

  it("auto-commits a finished gloopie onto the agent", () => {
    const completeSource = {
      ...baseSource,
      name: "Teapot",
      content: "Be helpful.",
      properties: {
        draft: true,
        builderSessionId: "s1",
        avatar: "app-avatar:old",
        provider: "openai",
        model: "gpt-5",
      },
    };
    const { update } = mockHook({ data: completeSource });
    // The user already picked this option from the four, so "done" is not a
    // review step: the finished gloopie becomes the avatar immediately.
    useGloopieGenerationStore.setState({
      jobs: {
        s1: {
          phase: "done",
          object: "teapot",
          options: [{ id: "choice", avatarRef: "user-avatar:choice" }],
          chosenOptionId: "choice",
          resultAvatarRef: "user-avatar:finished",
          errorCode: null,
          attemptId: 43,
        },
      },
    });

    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="teapot"
      />,
    );

    expect(update).toHaveBeenCalledWith({
      properties: { avatar: "user-avatar:finished" },
    });
    // The job resolves itself, so saving is not blocked.
    expect(
      useGloopieGenerationStore.getState().jobs.s1?.phase ?? "prompt",
    ).toBe("prompt");
    expect(
      screen.getByRole("button", { name: /save changes/i }),
    ).not.toHaveAttribute("aria-disabled", "true");
  });

  it("allows saving after a gloopie failure so the user is not trapped", () => {
    const completeSource = {
      ...baseSource,
      name: "Teapot",
      content: "Be helpful.",
      properties: {
        draft: true,
        builderSessionId: "s1",
        avatar: "app-avatar:old",
        provider: "openai",
        model: "gpt-5",
      },
    };
    mockHook({ data: completeSource });
    // A failed generation leaves no pending avatar, so it must not block save.
    useGloopieGenerationStore.setState({
      jobs: {
        s1: {
          phase: "error",
          object: "teapot",
          options: [],
          chosenOptionId: null,
          resultAvatarRef: null,
          errorCode: "unavailable",
          attemptId: 44,
        },
      },
    });

    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="teapot"
      />,
    );

    expect(
      screen.getByRole("button", { name: /save changes/i }),
    ).not.toHaveAttribute("aria-disabled", "true");
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
    const promotedSource = {
      ...baseSource,
      path: "/Users/x/.agents/agents/snark.md",
      name: "Snark",
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
    expect(button).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(button);

    await waitFor(() => {
      expect(saveNow).toHaveBeenCalled();
      expect(promoteDraft).toHaveBeenCalledWith("s1");
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

  it("opens the collection canvas overlay instead of the inline picker when the experiment is on", () => {
    setExperimentOverrides({ [AVATAR_COLLECTION_PAGE_EXPERIMENT_ID]: true });
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
      setExperimentOverrides({ [AVATAR_COLLECTION_PAGE_EXPERIMENT_ID]: true });
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

  it("reopens the takeover from the status card instead of a rail copy of the flow", () => {
    setExperimentOverrides({ [AVATAR_COLLECTION_PAGE_EXPERIMENT_ID]: true });
    mockHook();
    // Backgrounded, still generating: the rail shows only the compact status
    // card, and clicking it must reopen the full-screen surface.
    useGloopieGenerationStore.setState({
      jobs: {
        s1: {
          phase: "generating",
          object: "teapot",
          options: [],
          chosenOptionId: null,
          resultAvatarRef: null,
          errorCode: null,
          attemptId: 60,
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

    const statusCard = screen.getByRole("button", {
      name: /creating your gloopie/i,
    });
    expect(
      screen.queryByTestId("avatar-collection-overlay"),
    ).not.toBeInTheDocument();

    fireEvent.click(statusCard);

    const overlay = screen.getByTestId("avatar-collection-overlay");
    expect(overlay).toBeInTheDocument();
    // Progress lives on the takeover; the rail keeps showing the form.
    expect(
      within(overlay).getByRole("heading", { name: /creating your gloopie/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/agent name/i)).toBeInTheDocument();
  });

  it("auto-commits a finished gloopie instead of opening a review takeover", () => {
    setExperimentOverrides({ [AVATAR_COLLECTION_PAGE_EXPERIMENT_ID]: true });
    const { update } = mockHook();
    useGloopieGenerationStore.setState({
      jobs: {
        s1: {
          phase: "done",
          object: "teapot",
          options: [{ id: "choice", avatarRef: "user-avatar:choice" }],
          chosenOptionId: "choice",
          resultAvatarRef: "user-avatar:finished",
          errorCode: null,
          attemptId: 61,
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

    // No "ready, come review it" card and no takeover: the finished gloopie
    // simply became the avatar.
    expect(update).toHaveBeenCalledWith({
      properties: { avatar: "user-avatar:finished" },
    });
    expect(
      screen.queryByRole("button", { name: /your gloopie is ready/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("avatar-collection-overlay"),
    ).not.toBeInTheDocument();
  });

  it("keeps the classic inline picker when the collection canvas experiment is off", () => {
    mockHook();
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /select avatar/i }));

    expect(
      screen.getByRole("heading", { name: /choose an avatar/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("avatar-collection-overlay"),
    ).not.toBeInTheDocument();
  });

  it("hides the gloopie entry point when the experiment is off", () => {
    disableGloopieExperiment();
    mockHook();
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /select avatar/i }));

    expect(
      screen.getByRole("heading", { name: /choose an avatar/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /create your own/i }),
    ).not.toBeInTheDocument();
  });

  it("ignores in-flight gloopie work and never blocks save when the experiment is off", () => {
    disableGloopieExperiment();
    // A job left over from before the experiment was turned off must not leak
    // its status card, nor gate the save button, on the stable path.
    useGloopieGenerationStore.setState({
      jobs: {
        s1: {
          phase: "choosing",
          object: "teapot",
          options: [{ id: "choice", avatarRef: "user-avatar:choice" }],
          chosenOptionId: null,
          resultAvatarRef: null,
          errorCode: null,
          attemptId: 7,
        },
      },
    });
    // Every other required field is satisfied, so the ONLY thing that could
    // disable save here is the gloopie "choosing" phase. With the experiment on
    // this assertion fails, which is what makes the gate testable.
    mockHook({
      data: {
        ...baseSource,
        name: "Teapot",
        content: "Be helpful.",
        properties: {
          draft: true,
          builderSessionId: "s1",
          avatar: "app-avatar:old",
          provider: "openai",
          model: "gpt-5",
        },
      } as AgentSourceEntry,
      saveStatus: "unsaved",
    });
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );

    expect(
      screen.queryByText(/your gloopie options are ready/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /save changes/i }),
    ).not.toHaveAttribute("aria-disabled", "true");
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
