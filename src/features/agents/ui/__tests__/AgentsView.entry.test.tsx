import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportPersona } from "@/shared/api/agents";
import { saveExportedAgentFile } from "@/shared/api/system";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { toast } from "sonner";
import { AgentsView } from "../AgentsView";

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

vi.mock("@/shared/api/agents", () => ({
  exportPersona: vi.fn(),
  importPersonas: vi.fn(),
  readImportPersonaFile: vi.fn(),
  listPersonaSources: vi.fn().mockResolvedValue([mockDraftSource]),
  readAgentSourceFile: vi.fn().mockResolvedValue(mockDraftSource),
  updatePersonaSource: vi.fn().mockResolvedValue(mockDraftSource),
  deletePersonaSource: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/shared/api/system", () => ({
  saveExportedAgentFile: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/features/agents/hooks/usePersonas", () => ({
  usePersonas: () => ({
    createPersona: vi.fn(),
    deletePersona: vi.fn(),
    refreshFromDisk: vi.fn(),
  }),
}));

vi.mock("@/features/agents/hooks/useAvatarLibrary", () => ({
  useAvatarLibrary: () => ({
    catalog: null,
    cachedAvatarMediaById: {},
    loading: false,
    cacheChecking: false,
    error: false,
    errorCode: null,
    downloadingCollectionIds: new Set(),
    failedCollectionIds: new Set(),
    retryCatalog: () => {},
    openCollection: async () => {},
    isCollectionCached: () => false,
  }),
}));

const persona = {
  id: "/Users/x/.agents/agents/code-reviewer.md",
  displayName: "Code reviewer",
  systemPrompt: "Review code carefully.",
  isBuiltin: false,
  writable: true,
};

const exportedPersona = {
  contents: "---\nname: code-reviewer\n---\n\nReview code carefully.\n",
  filename: "code-reviewer.persona.md",
  mimeType: "text/markdown",
};

function setTauriInternals(value: unknown = {}): void {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value,
  });
}

async function clickDetailExport(): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "detail.moreActions" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "common:actions.export" }),
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

  it("clicking Create calls onStartAgentBuilderSession", () => {
    const onStartAgentBuilderSession = vi.fn();
    render(
      <AgentsView onStartAgentBuilderSession={onStartAgentBuilderSession} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "gallery.createAria" }));

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

  it("exports agents through the native save dialog in Tauri", async () => {
    const createObjectUrl = vi.spyOn(URL, "createObjectURL");
    vi.mocked(exportPersona).mockResolvedValue(exportedPersona);
    vi.mocked(saveExportedAgentFile).mockResolvedValue(
      "/Users/x/Desktop/custom-name.persona.md",
    );
    setTauriInternals();
    useAgentStore.setState({ personas: [persona] });

    render(<AgentsView activePersonaId={persona.id} />);

    await clickDetailExport();

    await waitFor(() => {
      expect(exportPersona).toHaveBeenCalledWith(persona.id);
      expect(saveExportedAgentFile).toHaveBeenCalledWith(
        "code-reviewer.persona.md",
        exportedPersona.contents,
      );
      expect(toast.success).toHaveBeenCalledWith(
        "view.exportedTo:custom-name.persona.md",
      );
    });
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it("stays silent when native agent export is canceled", async () => {
    vi.mocked(exportPersona).mockResolvedValue(exportedPersona);
    vi.mocked(saveExportedAgentFile).mockResolvedValue(null);
    setTauriInternals();
    useAgentStore.setState({ personas: [persona] });

    render(<AgentsView activePersonaId={persona.id} />);

    await clickDetailExport();

    await waitFor(() => {
      expect(saveExportedAgentFile).toHaveBeenCalledWith(
        "code-reviewer.persona.md",
        exportedPersona.contents,
      );
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("keeps the browser download fallback outside Tauri", async () => {
    const createObjectUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:agent-export");
    const revokeObjectUrl = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const clickAnchor = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    vi.mocked(exportPersona).mockResolvedValue(exportedPersona);
    useAgentStore.setState({ personas: [persona] });

    render(<AgentsView activePersonaId={persona.id} />);

    await clickDetailExport();

    await waitFor(() => {
      expect(createObjectUrl).toHaveBeenCalledTimes(1);
      expect(clickAnchor).toHaveBeenCalledTimes(1);
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:agent-export");
      expect(toast.success).toHaveBeenCalledWith(
        "view.exportedTo:code-reviewer.persona.md",
      );
    });
    expect(saveExportedAgentFile).not.toHaveBeenCalled();
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
