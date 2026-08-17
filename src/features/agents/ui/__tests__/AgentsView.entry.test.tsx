import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { toast } from "sonner";
import { AgentsView } from "../AgentsView";

const mockCreatePersona = vi.hoisted(() => vi.fn());

const mockDraftSource = vi.hoisted(() => ({
  type: "agent",
  path: "/Users/x/.agents/agents/draft-session.md",
  name: "New agent",
  description: "Draft",
  content: "Draft in progress.",
  global: true,
  writable: true,
  properties: {
    draft: true,
    builderSessionId: "draft-session",
    avatar: "app-avatar:gloopies-1",
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      key === "view.exportedTo" && typeof options?.filename === "string"
        ? `${key}:${options.filename}`
        : key,
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@/shared/api/artifacts", () => ({
  ARTIFACTS_QUERY_KEY: ["artifacts"],
  getArtifacts: vi.fn().mockResolvedValue({
    catalogVersion: "test",
    assets: [
      {
        kind: "collectionImage",
        path: "/avatars/gloopies-1.png",
        mimeType: "image/png",
        byteSize: 4,
        sha256: "test",
      },
    ],
  }),
  selectAvatarImageUrl: (
    artifacts: { assets: Array<{ path: string }> },
    id: string,
  ) =>
    artifacts.assets.find((asset) => asset.path.endsWith(`/${id}.png`))?.path,
}));

vi.mock("@/shared/api/agents", () => ({
  exportPersona: vi.fn(),
  importPersonas: vi.fn(),
  readImportPersonaFile: vi.fn(),
  listPersonaSources: vi.fn().mockResolvedValue([mockDraftSource]),
  readAgentSourceFile: vi.fn().mockResolvedValue(mockDraftSource),
  updatePersonaSource: vi.fn().mockResolvedValue(mockDraftSource),
  deletePersonaSource: vi.fn().mockResolvedValue(undefined),
  isPlaceholderAgentDescription: (description: string | undefined | null) => {
    const trimmed = description?.trim().toLowerCase();
    return !trimmed || trimmed === "agent" || trimmed === "draft";
  },
  hasRealAgentDescription: (description: string | undefined | null) => {
    const trimmed = description?.trim().toLowerCase();
    return Boolean(trimmed) && trimmed !== "agent" && trimmed !== "draft";
  },
}));

vi.mock("@/shared/api/system", () => ({
  saveExportedAgentFile: vi.fn(),
  saveExportedAgentImage: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/features/agents/hooks/usePersonas", () => ({
  usePersonas: () => ({
    createPersona: mockCreatePersona,
    deletePersona: vi.fn(),
    refreshFromDisk: vi.fn(),
  }),
}));

vi.mock("@/features/agents/ui/PersonaFields/ProviderModelFields", () => ({
  ProviderModelFields: () => <div data-testid="provider-model-fields" />,
}));

vi.mock("@/features/agents/hooks/useAvatarLibrary", () => ({
  useAvatarLibrary: () => ({
    catalog: null,
    cachedAvatarMediaById: {},
    loading: false,
    cacheChecking: false,
    error: false,
    errorCode: null,
    mediaError: false,
    mediaErrorCode: null,
    retryCatalog: () => {},
    retryMedia: () => {},
  }),
}));

const persona = {
  id: "/Users/x/.agents/agents/code-reviewer.md",
  displayName: "Code reviewer",
  systemPrompt: "Review code carefully.",
  isBuiltin: false,
  writable: true,
};

async function openDetailShareDialog(): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "detail.moreActions" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "share.action" }),
  );
}

describe("AgentsView entry points", () => {
  const originalMatchMedia = window.matchMedia;
  const originalStartViewTransition = (
    document as Document & {
      startViewTransition?: (callback: () => void) => unknown;
    }
  ).startViewTransition;

  afterEach(() => {
    if (originalStartViewTransition) {
      Object.defineProperty(document, "startViewTransition", {
        configurable: true,
        value: originalStartViewTransition,
      });
    } else {
      Reflect.deleteProperty(document, "startViewTransition");
    }
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
    delete document.documentElement.dataset.agentTransition;
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    useAgentStore.setState({
      personas: [],
      personasLoading: false,
      providers: [],
    });
    useChatSessionStore.setState({
      sessions: [],
      activeSessionId: null,
      isLoading: false,
      hasHydratedSessions: false,
    });
  });

  it("offers equal stacked create and reviewed import actions in the empty state", async () => {
    const user = userEvent.setup();
    render(<AgentsView />);

    const createButton = screen.getByRole("button", {
      name: "gallery.createAria",
    });
    const importButton = screen.getByRole("button", {
      name: "gallery.importViaImage",
    });
    expect(createButton).toHaveClass("w-full", "text-sm");
    expect(importButton).toHaveClass("w-full", "text-sm");

    await user.click(importButton);
    expect(
      screen.getByRole("heading", { name: "importDialog.title" }),
    ).toBeInTheDocument();
    expect(mockCreatePersona).not.toHaveBeenCalled();
  });

  it("shows share-card actions", async () => {
    useAgentStore.setState({ personas: [persona] });
    const user = userEvent.setup();

    render(<AgentsView activePersonaId={persona.id} />);
    await user.click(
      screen.getByRole("button", { name: "detail.moreActions" }),
    );

    expect(
      screen.getByRole("menuitem", { name: "share.action" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "common:actions.export" }),
    ).not.toBeInTheDocument();
  });

  it("opens the share dialog from a gallery card", async () => {
    useAgentStore.setState({ personas: [persona] });
    const user = userEvent.setup();

    render(<AgentsView />);
    await user.click(screen.getByRole("button", { name: "card.options" }));

    expect(
      screen.queryByRole("menuitem", { name: "common:actions.export" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "share.action" }));

    expect(screen.getByText("share.title")).toBeInTheDocument();
  });

  it("opens a no-write preview when selecting a compatible PNG", async () => {
    const fixtureBytes = readFileSync(
      resolve(
        process.cwd(),
        "src/features/agents/agent-snapshot/fixtures/buzz-v1-config-only.agent.png",
      ),
    );
    const file = new File([fixtureBytes], "shared.png", { type: "image/png" });
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: vi
        .fn()
        .mockResolvedValue(
          fixtureBytes.buffer.slice(
            fixtureBytes.byteOffset,
            fixtureBytes.byteOffset + fixtureBytes.byteLength,
          ),
        ),
    });
    const { container } = render(<AgentsView />);
    const input = container.querySelector<HTMLInputElement>(
      'input[type="file"][accept*="image/png"]',
    );
    expect(input).not.toBeNull();

    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });

    expect(
      await screen.findByRole("heading", { name: "imageImport.description" }),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("Test Agent Display")).toBeInTheDocument();
    expect(screen.getByText("You are a test agent.")).toBeInTheDocument();
  });

  it("reports malformed PNG imports instead of rejecting silently", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "broken.png", {
      type: "image/png",
    });
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
    });
    const { container } = render(<AgentsView />);
    const input = container.querySelector<HTMLInputElement>(
      'input[type="file"][accept*="image/png"]',
    );

    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(
      screen.queryByRole("heading", { name: "imageImport.description" }),
    ).not.toBeInTheDocument();
  });

  it("offers image import or new agent from the plus tile", async () => {
    const onStartAgentBuilderSession = vi.fn();
    useAgentStore.setState({ personas: [persona] });
    render(
      <AgentsView onStartAgentBuilderSession={onStartAgentBuilderSession} />,
    );

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "gallery.addAgentAria" }),
    );

    expect(
      await screen.findByRole("button", { name: "gallery.importViaImage" }),
    ).toBeInTheDocument();
    await user.click(document.body);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "gallery.importViaImage" }),
      ).not.toBeInTheDocument(),
    );

    await user.click(
      screen.getByRole("button", { name: "gallery.addAgentAria" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "gallery.createNew" }),
    );
    expect(onStartAgentBuilderSession).toHaveBeenCalledWith({});
  });

  it("shows draft sessions at the end of the gallery and continues or deletes them", async () => {
    const onStartAgentBuilderSession = vi.fn();
    const onDeleteDraftSession = vi.fn();
    useAgentStore.setState({ personas: [persona] });
    useChatSessionStore.setState({
      sessions: [
        {
          id: "draft-session",
          title: "New agent",
          createdAt: "2026-06-09T00:00:00.000Z",
          updatedAt: "2026-06-09T00:00:00.000Z",
          messageCount: 0,
          intent: "build-agent",
          targetAgentPath: "/Users/x/.agents/agents/draft-session.md",
          targetAgentSlug: "draft-session",
          targetAgentDraftState: null,
          targetAgentDraftSaved: true,
        },
      ],
    });

    render(
      <AgentsView
        onStartAgentBuilderSession={onStartAgentBuilderSession}
        onDeleteDraftSession={onDeleteDraftSession}
      />,
    );

    expect(screen.getByText("gallery.draft")).toBeInTheDocument();
    expect(screen.getByText("gallery.draftDescription")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "gallery.continueDraftAria" }),
    );

    expect(onStartAgentBuilderSession).toHaveBeenCalledWith({
      path: "/Users/x/.agents/agents/draft-session.md",
      slug: "draft-session",
    });

    await user.click(
      screen.getByRole("button", { name: "gallery.deleteDraftAria" }),
    );

    expect(onDeleteDraftSession).toHaveBeenCalledWith("draft-session");
  });

  it("returns from the detail page to the agents gallery", () => {
    const onActivePersonaIdChange = vi.fn();
    useAgentStore.setState({ personas: [persona] });

    render(
      <AgentsView
        activePersonaId={persona.id}
        onActivePersonaIdChange={onActivePersonaIdChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "view.backToAgents" }));

    expect(onActivePersonaIdChange).toHaveBeenCalledWith(null, undefined);
  });

  it("shows the agent's description on the detail page, next to provider and model", () => {
    useAgentStore.setState({
      personas: [
        { ...persona, sourceDescription: "Reviews your code carefully." },
      ],
    });

    render(<AgentsView activePersonaId={persona.id} />);

    expect(screen.getByText("view.description")).toBeInTheDocument();
    expect(
      screen.getByText("Reviews your code carefully."),
    ).toBeInTheDocument();
  });

  it("shows no description row on the detail page when there's no real description", () => {
    useAgentStore.setState({ personas: [persona] });

    render(<AgentsView activePersonaId={persona.id} />);

    expect(screen.queryByText("view.description")).not.toBeInTheDocument();
  });

  it("shows and activates the avatar customization affordance", async () => {
    useAgentStore.setState({ personas: [persona] });
    const user = userEvent.setup();

    render(<AgentsView activePersonaId={persona.id} />);

    const customizeAvatar = screen.getByRole("button", {
      name: "editor.customizeAvatar",
    });
    expect(screen.getByText("builderRail.changeAvatar")).toBeInTheDocument();
    customizeAvatar.focus();
    expect(customizeAvatar).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(screen.getByText("editor.avatarUrl")).toBeInTheDocument();
  });

  it("clicking detail Start chat calls onStartChatWithAgent with the persona id", () => {
    const onStartChatWithAgent = vi.fn();
    useAgentStore.setState({ personas: [persona] });

    render(
      <AgentsView
        activePersonaId={persona.id}
        onStartChatWithAgent={onStartChatWithAgent}
      />,
    );

    const startChatButton = screen.getByRole("button", {
      name: "detail.startChat",
    });
    expect(startChatButton).toHaveClass("bg-surface-agent-profile-control-bg");

    fireEvent.click(startChatButton);

    expect(onStartChatWithAgent).toHaveBeenCalledWith(persona.id);
  });

  it("clicking detail edit calls onStartAgentBuilderSession with the source path and slug", () => {
    const onStartAgentBuilderSession = vi.fn();
    useAgentStore.setState({ personas: [persona] });

    render(
      <AgentsView
        activePersonaId={persona.id}
        onStartAgentBuilderSession={onStartAgentBuilderSession}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "common:actions.edit" }),
    );

    expect(onStartAgentBuilderSession).toHaveBeenCalledWith({
      path: "/Users/x/.agents/agents/code-reviewer.md",
      slug: "code-reviewer",
    });
  });

  it("keeps an open share dialog synced to the live persona", async () => {
    useAgentStore.setState({ personas: [persona] });
    render(<AgentsView activePersonaId={persona.id} />);

    await openDetailShareDialog();
    expect(screen.getByText("share.title")).toBeInTheDocument();

    act(() => {
      useAgentStore.getState().updatePersona(persona.id, {
        displayName: "Updated reviewer",
        systemPrompt: "Updated instructions.",
      });
    });

    expect(screen.getByText("Updated reviewer")).toBeInTheDocument();
    expect(screen.getByText("Updated instructions.")).toBeInTheDocument();

    act(() => {
      useAgentStore.getState().removePersona(persona.id);
    });
    await waitFor(() => {
      expect(screen.queryByText("Updated reviewer")).not.toBeInTheDocument();
    });
  });

  it("preserves the provider-qualified model when duplicating an agent", async () => {
    const qualifiedPersona = {
      ...persona,
      provider: "goose",
      modelProviderId: "openai",
      model: "gpt-5.6",
    };
    useAgentStore.setState({ personas: [qualifiedPersona] });

    render(
      <AgentsView
        activePersonaId={qualifiedPersona.id}
        onStartAgentBuilderSession={vi.fn()}
      />,
    );

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "detail.moreActions" }),
    );
    await user.click(
      screen.getByRole("menuitem", { name: "common:actions.duplicate" }),
    );

    expect(mockCreatePersona).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "goose",
        modelProviderId: "openai",
        model: "gpt-5.6",
      }),
    );
  });

  it("starts a gallery-to-profile view transition when opening detail", () => {
    const resolved = Promise.resolve();
    const startViewTransition = vi.fn((callback: () => void) => {
      expect(document.documentElement.dataset.agentTransition).toBe(
        "gallery-to-profile",
      );
      callback();
      return {
        finished: resolved,
        ready: resolved,
        updateCallbackDone: resolved,
        skipTransition: vi.fn(),
      };
    });
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: startViewTransition,
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
    useAgentStore.setState({ personas: [persona] });

    render(<AgentsView />);

    fireEvent.click(screen.getByRole("button", { name: "card.viewAria" }));

    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("heading", { name: persona.displayName }),
    ).toBeInTheDocument();
  });
});
