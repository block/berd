import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { zipSync } from "fflate";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { toast } from "sonner";
import { importPersonas } from "@/shared/api/agents";
import { useAvatarLibrary } from "@/features/agents/hooks/useAvatarLibrary";
import type { AvatarLibraryState } from "@/features/agents/hooks/useAvatarLibrary";
import type { CreatePersonaRequest } from "@/shared/types/agents";
import { AgentsView } from "../AgentsView";

const mockCreatePersona = vi.hoisted(() => vi.fn());
const mockUpdatePersona = vi.hoisted(() => vi.fn());
const mockTrackAgentCreateCompleted = vi.hoisted(() => vi.fn());
const mockTrackAgentEditCompleted = vi.hoisted(() => vi.fn());

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

const mockExtractInWorker = vi.hoisted(() => vi.fn());

vi.mock("@/features/agents/lib/agentZipImport", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/features/agents/lib/agentZipImport")
    >();
  mockExtractInWorker.mockImplementation(async (bytes: Uint8Array) =>
    actual.extractAgentFileFromZip(bytes),
  );
  return {
    ...actual,
    extractAgentFileFromZipInWorker: mockExtractInWorker,
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === "view.exportedTo" && typeof options?.filename === "string") {
        return `${key}:${options.filename}`;
      }
      return typeof options?.defaultValue === "string"
        ? options.defaultValue
        : key;
    },
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

vi.mock("@/shared/api/agents", async (importOriginal) => ({
  // The preview builder is pure; the real one keeps gallery-drop tests
  // exercising the actual parse-and-preview path.
  previewPersonaImport: (
    await importOriginal<typeof import("@/shared/api/agents")>()
  ).previewPersonaImport,
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

vi.mock("@/features/agents/lib/agentTelemetry", () => ({
  trackAgentCreateCompleted: mockTrackAgentCreateCompleted,
  trackAgentEditCompleted: mockTrackAgentEditCompleted,
  trackAgentDeleteCompleted: vi.fn(),
}));

vi.mock("@/features/agents/hooks/usePersonas", () => ({
  usePersonas: () => ({
    createPersona: mockCreatePersona,
    updatePersona: mockUpdatePersona,
    deletePersona: vi.fn(),
    refreshFromDisk: vi.fn(),
  }),
}));

vi.mock("@/features/agents/ui/PersonaFields/ProviderModelFields", () => ({
  ProviderModelFields: () => <div data-testid="provider-model-fields" />,
}));

vi.mock("@/features/agents/hooks/useAvatarLibrary", () => ({
  useAvatarLibrary: vi.fn(),
}));

const EMPTY_AVATAR_LIBRARY: AvatarLibraryState = {
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
  retryCatalog: () => {},
  retryMedia: () => {},
};

/**
 * A one-avatar library, cached and ready, so the collection gallery renders a
 * real selectable tile instead of an empty canvas.
 */
function singleAvatarLibrary(avatarId: string): AvatarLibraryState {
  const variant = (extension: string, mimeType: string) => ({
    path: `${avatarId}.${extension}`,
    mimeType,
    byteSize: 1,
    sha256: avatarId,
  });

  return {
    ...EMPTY_AVATAR_LIBRARY,
    catalog: {
      schemaVersion: 1,
      catalogVersion: "v1",
      collections: [
        {
          id: "gloopies",
          label: "Gloopies",
          coverAvatarId: avatarId,
          avatarIds: [avatarId],
        },
      ],
      assets: [
        {
          id: avatarId,
          label: avatarId,
          collectionId: "gloopies",
          variants: {
            webm: variant("webm", "video/webm"),
            hevc: variant("mov", "video/quicktime"),
          },
        },
      ],
    },
    cachedAvatarMediaById: {
      [avatarId]: {
        catalogVersion: "v1",
        media: { src: `cached-${avatarId}`, mediaType: "image" },
      },
    },
  };
}

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

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(useAvatarLibrary).mockReturnValue(EMPTY_AVATAR_LIBRARY);
    // Restore the default passthrough after tests that defer extraction.
    const actualZipImport = await vi.importActual<
      typeof import("@/features/agents/lib/agentZipImport")
    >("@/features/agents/lib/agentZipImport");
    mockExtractInWorker.mockImplementation(async (bytes: Uint8Array) =>
      actualZipImport.extractAgentFileFromZip(bytes),
    );
    // Mirrors the real API: the created persona carries the persisted
    // identity the telemetry call sites are expected to report.
    mockCreatePersona.mockImplementation(
      async (request: CreatePersonaRequest) => ({
        id: "/Users/x/.agents/agents/created.md",
        displayName: request.displayName,
        systemPrompt: request.systemPrompt,
        provider: request.provider,
        modelProviderId: request.modelProviderId,
        model: request.model,
        isBuiltin: false,
        writable: true,
      }),
    );
    // Mirrors the real API: the updated persona carries the persisted
    // identity the telemetry call site is expected to report.
    mockUpdatePersona.mockImplementation(
      async (existing: typeof persona, request: Record<string, unknown>) => ({
        ...existing,
        ...request,
      }),
    );
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

    // Gallery selections route through the shared import dialog preview.
    await userEvent.click(
      await screen.findByRole("button", { name: "importDialog.import" }),
    );
    expect(
      await screen.findByRole("heading", { name: "imageImport.description" }),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("Test Agent Display")).toBeInTheDocument();
    expect(screen.getByText("You are a test agent.")).toBeInTheDocument();
  });

  it("previews a portable agent image imported from a ZIP", async () => {
    const fixtureBytes = readFileSync(
      resolve(
        process.cwd(),
        "src/features/agents/agent-snapshot/fixtures/buzz-v1-config-only.agent.png",
      ),
    );
    const archive = zipSync({ "shared.agent.png": fixtureBytes });
    const file = new File([archive], "shared.agent.zip", {
      type: "application/zip",
    });
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: vi.fn().mockResolvedValue(archive.buffer),
    });
    render(<AgentsView />);
    await userEvent.click(
      screen.getByRole("button", { name: "gallery.importViaImage" }),
    );
    const input = document.querySelector<HTMLInputElement>(
      'input[type="file"][accept*="application/zip"]',
    );
    expect(input).not.toBeNull();

    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });

    expect(
      await screen.findByRole("img", { name: "importDialog.previewAlt" }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "importDialog.import" }),
    );
    expect(
      await screen.findByRole("heading", { name: "imageImport.description" }),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("Test Agent Display")).toBeInTheDocument();
  });

  it("routes gallery ZIP drops into the import dialog for confirmation", async () => {
    vi.mocked(importPersonas).mockResolvedValue([]);
    const archive = zipSync({
      "reviewer.persona.md": new TextEncoder().encode(
        "---\nname: reviewer\n---\nReview.",
      ),
    });
    const file = new File([archive], "reviewer.zip", {
      type: "application/zip",
    });
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: vi.fn().mockResolvedValue(archive.buffer),
    });
    const { container } = render(<AgentsView />);
    const dropZone = container.querySelector(".\\@container") as HTMLElement;

    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });

    // The drop opens the shared dialog and prepares through the worker; no
    // personas are created before the user confirms.
    await waitFor(() => expect(mockExtractInWorker).toHaveBeenCalled());
    expect(
      await screen.findByRole("button", { name: "importDialog.import" }),
    ).toBeInTheDocument();
    expect(importPersonas).not.toHaveBeenCalled();

    await userEvent.click(
      screen.getByRole("button", { name: "importDialog.import" }),
    );
    await waitFor(() =>
      expect(importPersonas).toHaveBeenCalledWith(
        expect.stringContaining("Review."),
        "reviewer.persona.md",
      ),
    );
  });

  it("only the latest gallery drop can win an extraction race", async () => {
    vi.mocked(importPersonas).mockResolvedValue([]);
    const resolvers: Array<{
      name: string;
      resolve: (value: { bytes: Uint8Array; name: string }) => void;
      reject: (reason: unknown) => void;
      signal?: AbortSignal;
    }> = [];
    mockExtractInWorker.mockImplementation(
      (_bytes: Uint8Array, signal?: AbortSignal) =>
        new Promise((resolve, reject) => {
          resolvers.push({
            name: `drop-${resolvers.length}`,
            resolve,
            reject,
            signal,
          });
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const makeZipFile = (name: string) => {
      const archive = zipSync({
        [`${name}.persona.md`]: new TextEncoder().encode(
          `---\nname: ${name}\n---\n${name}`,
        ),
      });
      const file = new File([archive], `${name}.zip`, {
        type: "application/zip",
      });
      Object.defineProperty(file, "arrayBuffer", {
        configurable: true,
        value: vi.fn().mockResolvedValue(archive.buffer),
      });
      return file;
    };
    const { container } = render(<AgentsView />);
    const dropZone = container.querySelector(".\\@container") as HTMLElement;

    fireEvent.drop(dropZone, {
      dataTransfer: {
        files: [makeZipFile("a")],
        items: [{ kind: "file" }],
        types: ["Files"],
      },
    });
    await waitFor(() => expect(resolvers).toHaveLength(1));

    // Dropping B onto the dialog's drop zone replaces A and aborts its work.
    const dialogDropZone = screen.getByRole("status");
    const fileB = makeZipFile("b");
    fireEvent.drop(dialogDropZone, {
      dataTransfer: {
        files: [fileB],
        items: [{ kind: "file" }],
        types: ["Files"],
      },
    });
    await waitFor(() => expect(resolvers).toHaveLength(2));
    expect(resolvers[0].signal?.aborted).toBe(true);

    // A resolving late must not surface or import.
    resolvers[0].resolve({
      bytes: new TextEncoder().encode("---\nname: a\n---\na"),
      name: "a.persona.md",
    });
    resolvers[1].resolve({
      bytes: new TextEncoder().encode("---\nname: b\n---\nb"),
      name: "b.persona.md",
    });
    expect(
      await screen.findByRole("button", { name: "importDialog.import" }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "importDialog.import" }),
    );
    await waitFor(() =>
      expect(importPersonas).toHaveBeenCalledWith(
        expect.stringContaining("b"),
        "b.persona.md",
      ),
    );
    expect(importPersonas).not.toHaveBeenCalledWith(
      expect.anything(),
      "a.persona.md",
    );
  });

  it("gallery drops still preview under StrictMode effect replay", async () => {
    const revokeSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const seenSignals: AbortSignal[] = [];
    const actualZipImport = await vi.importActual<
      typeof import("@/features/agents/lib/agentZipImport")
    >("@/features/agents/lib/agentZipImport");
    mockExtractInWorker.mockImplementation(
      async (bytes: Uint8Array, signal?: AbortSignal) => {
        if (signal) seenSignals.push(signal);
        return actualZipImport.extractAgentFileFromZip(bytes);
      },
    );
    const archive = zipSync({
      "reviewer.persona.md": new TextEncoder().encode(
        "---\nname: reviewer\n---\nReview.",
      ),
    });
    const file = new File([archive], "reviewer.zip", {
      type: "application/zip",
    });
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: vi.fn().mockResolvedValue(archive.buffer),
    });
    const { container } = render(
      <StrictMode>
        <AgentsView />
      </StrictMode>,
    );
    const dropZone = container.querySelector(".\\@container") as HTMLElement;

    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });

    // StrictMode replays the initial-file effect: the first attempt is
    // aborted by cleanup and the replayed effect restarts preparation.
    expect(
      await screen.findByRole("button", { name: "importDialog.import" }),
    ).toBeInTheDocument();
    expect(seenSignals.length).toBeGreaterThanOrEqual(2);
    expect(seenSignals[0].aborted).toBe(true);
    expect(seenSignals.at(-1)?.aborted).toBe(false);
    // Exactly one preview is live; any aborted attempt revoked its URL.
    const liveUrls = revokeSpy.mock.calls.length;
    expect(liveUrls).toBeLessThanOrEqual(seenSignals.length - 1);
    revokeSpy.mockRestore();
  });

  it("closing the dialog cancels a pending gallery ZIP preparation", async () => {
    let capturedSignal: AbortSignal | undefined;
    mockExtractInWorker.mockImplementation(
      (_bytes: Uint8Array, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          capturedSignal = signal;
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const archive = zipSync({
      "reviewer.persona.md": new TextEncoder().encode("---\n---\nReview."),
    });
    const file = new File([archive], "reviewer.zip", {
      type: "application/zip",
    });
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: vi.fn().mockResolvedValue(archive.buffer),
    });
    const { container } = render(<AgentsView />);
    const dropZone = container.querySelector(".\\@container") as HTMLElement;

    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });
    await waitFor(() => expect(capturedSignal).toBeDefined());

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(capturedSignal?.aborted).toBe(true));
    expect(importPersonas).not.toHaveBeenCalled();
  });

  it("shows a localized error for an ambiguous agent ZIP", async () => {
    const archive = zipSync({
      "one.persona.md": new TextEncoder().encode("one"),
      "two.json": new TextEncoder().encode("{}"),
    });
    const file = new File([archive], "agents.zip", {
      type: "application/zip",
    });
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: vi.fn().mockResolvedValue(archive.buffer),
    });
    render(<AgentsView />);
    await userEvent.click(
      screen.getByRole("button", { name: "gallery.importViaImage" }),
    );
    const input = document.querySelector<HTMLInputElement>(
      'input[type="file"][accept*="application/zip"]',
    );
    expect(input).not.toBeNull();

    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("zipImport.multipleAgents"),
    );
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

    expect(screen.getByText("Description")).toBeInTheDocument();
    expect(
      screen.getByText("Reviews your code carefully."),
    ).toBeInTheDocument();
  });

  it("shows no description row on the detail page when there's no real description", () => {
    useAgentStore.setState({ personas: [persona] });

    render(<AgentsView activePersonaId={persona.id} />);

    expect(screen.queryByText("Description")).not.toBeInTheDocument();
  });

  it("opens the avatar collection gallery from the customization affordance", async () => {
    useAgentStore.setState({ personas: [persona] });
    const user = userEvent.setup();

    render(<AgentsView activePersonaId={persona.id} />);

    const customizeAvatar = screen.getByRole("button", {
      name: "editor.customizeAvatar",
    });
    expect(screen.getByText("editor.changeAvatar")).toBeInTheDocument();
    customizeAvatar.focus();
    expect(customizeAvatar).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(screen.getByTestId("avatar-collection-overlay")).toBeInTheDocument();
  });

  it("persists the avatar picked in the collection gallery and closes the takeover", async () => {
    vi.mocked(useAvatarLibrary).mockReturnValue(
      singleAvatarLibrary("gloopies-1"),
    );
    // jsdom reports zero rects; give the gallery canvas a real size so the
    // scatter layout has a tile to lay avatars into.
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
    useAgentStore.setState({ personas: [persona] });
    const user = userEvent.setup();

    render(<AgentsView activePersonaId={persona.id} />);

    await user.click(
      screen.getByRole("button", { name: "editor.customizeAvatar" }),
    );

    // Picking is two-step in the gallery: click highlights, Select commits.
    const overlay = within(screen.getByTestId("avatar-collection-overlay"));
    await user.click(overlay.getAllByRole("button", { name: "gloopies-1" })[0]);
    await user.click(
      overlay.getAllByRole("button", { name: "collectionPage.select" })[0],
    );

    // The selection is persisted as an app-avatar ref, not a raw id.
    await waitFor(() =>
      expect(mockUpdatePersona).toHaveBeenCalledWith(
        expect.objectContaining({ id: persona.id }),
        { avatar: "app-avatar:gloopies-1" },
      ),
    );
    expect(mockTrackAgentEditCompleted).toHaveBeenCalledTimes(1);
    expect(mockTrackAgentEditCompleted).toHaveBeenCalledWith({
      provider: undefined,
      model: undefined,
    });

    // The takeover hands control back to the profile after committing.
    await waitFor(() =>
      expect(
        screen.queryByTestId("avatar-collection-overlay"),
      ).not.toBeInTheDocument(),
    );
  });

  it("does not report a completed edit when a canvas selection fails to persist", async () => {
    vi.mocked(useAvatarLibrary).mockReturnValue(
      singleAvatarLibrary("gloopies-1"),
    );
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
    mockUpdatePersona.mockRejectedValueOnce(new Error("update failed"));
    useAgentStore.setState({ personas: [persona] });
    const user = userEvent.setup();

    render(<AgentsView activePersonaId={persona.id} />);
    await user.click(
      screen.getByRole("button", { name: "editor.customizeAvatar" }),
    );
    const overlay = within(screen.getByTestId("avatar-collection-overlay"));
    await user.click(overlay.getAllByRole("button", { name: "gloopies-1" })[0]);
    await user.click(
      overlay.getAllByRole("button", { name: "collectionPage.select" })[0],
    );

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(mockTrackAgentEditCompleted).not.toHaveBeenCalled();
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

  describe("berd_agent Create Completed", () => {
    function agentImageFixtureFile(): File {
      const fixtureBytes = readFileSync(
        resolve(
          process.cwd(),
          "src/features/agents/agent-snapshot/fixtures/buzz-v1-config-only.agent.png",
        ),
      );
      const file = new File([fixtureBytes], "shared.png", {
        type: "image/png",
      });
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
      return file;
    }

    function importTextFile(name: string, type: string): File {
      const contents = name.endsWith(".json")
        ? JSON.stringify({
            version: 1,
            displayName: "Imported",
            systemPrompt: "Imported prompt.",
          })
        : "---\nname: Imported\n---\nImported prompt.";
      const bytes = new TextEncoder().encode(contents);
      const file = new File([bytes], name, { type });
      Object.defineProperty(file, "arrayBuffer", {
        configurable: true,
        value: vi.fn().mockResolvedValue(bytes.buffer),
      });
      return file;
    }

    async function duplicateActivePersona(): Promise<void> {
      const user = userEvent.setup();
      await user.click(
        screen.getByRole("button", { name: "detail.moreActions" }),
      );
      await user.click(
        screen.getByRole("menuitem", { name: "common:actions.duplicate" }),
      );
    }

    it("fires once with the created copy's identity after a successful duplicate", async () => {
      const qualifiedPersona = {
        ...persona,
        provider: "goose",
        modelProviderId: "openai",
        model: "gpt-5.6",
      };
      useAgentStore.setState({ personas: [qualifiedPersona] });
      render(<AgentsView activePersonaId={qualifiedPersona.id} />);

      await duplicateActivePersona();

      await waitFor(() =>
        expect(mockTrackAgentCreateCompleted).toHaveBeenCalledTimes(1),
      );
      expect(mockTrackAgentCreateCompleted).toHaveBeenCalledWith({
        provider: "goose",
        model: "gpt-5.6",
      });
    });

    it("does not fire when duplicating fails", async () => {
      mockCreatePersona.mockRejectedValueOnce(new Error("create failed"));
      useAgentStore.setState({ personas: [persona] });
      render(<AgentsView activePersonaId={persona.id} />);

      await duplicateActivePersona();

      await waitFor(() => expect(toast.error).toHaveBeenCalled());
      expect(mockTrackAgentCreateCompleted).not.toHaveBeenCalled();
    });

    it("fires once per persona actually created by a file import", async () => {
      vi.mocked(importPersonas).mockResolvedValue([
        {
          id: "/Users/x/.agents/agents/imported-one.md",
          displayName: "Imported one",
          systemPrompt: "One.",
          provider: "goose",
          model: "gpt-5.6",
          isBuiltin: false,
          writable: true,
        },
        {
          id: "/Users/x/.agents/agents/imported-two.md",
          displayName: "Imported two",
          systemPrompt: "Two.",
          isBuiltin: false,
          writable: true,
        },
      ]);
      const { container } = render(<AgentsView />);
      const input =
        container.querySelector<HTMLInputElement>('input[type="file"]');

      fireEvent.change(input as HTMLInputElement, {
        target: {
          files: [importTextFile("team.agent.json", "application/json")],
        },
      });
      await userEvent.click(
        await screen.findByRole("button", { name: "importDialog.import" }),
      );

      await waitFor(() =>
        expect(mockTrackAgentCreateCompleted).toHaveBeenCalledTimes(2),
      );
      expect(mockTrackAgentCreateCompleted).toHaveBeenCalledWith({
        provider: "goose",
        model: "gpt-5.6",
      });
      expect(mockTrackAgentCreateCompleted).toHaveBeenCalledWith({
        provider: undefined,
        model: undefined,
      });
    });

    it("does not fire when a file import fails", async () => {
      vi.mocked(importPersonas).mockRejectedValue(new Error("import failed"));
      const { container } = render(<AgentsView />);
      const input =
        container.querySelector<HTMLInputElement>('input[type="file"]');

      fireEvent.change(input as HTMLInputElement, {
        target: {
          files: [importTextFile("reviewer.persona.md", "text/markdown")],
        },
      });
      await userEvent.click(
        await screen.findByRole("button", { name: "importDialog.import" }),
      );

      await waitFor(() => expect(toast.error).toHaveBeenCalled());
      expect(mockTrackAgentCreateCompleted).not.toHaveBeenCalled();
    });

    it("fires once after a confirmed agent-image import", async () => {
      const { container } = render(<AgentsView />);
      const input = container.querySelector<HTMLInputElement>(
        'input[type="file"][accept*="image/png"]',
      );

      fireEvent.change(input as HTMLInputElement, {
        target: { files: [agentImageFixtureFile()] },
      });
      await userEvent.click(
        await screen.findByRole("button", { name: "importDialog.import" }),
      );
      await screen.findByRole("heading", { name: "imageImport.description" });
      expect(mockTrackAgentCreateCompleted).not.toHaveBeenCalled();

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "imageImport.add" }));

      await waitFor(() =>
        expect(mockTrackAgentCreateCompleted).toHaveBeenCalledTimes(1),
      );
      expect(mockTrackAgentCreateCompleted).toHaveBeenCalledWith({
        provider: undefined,
        model: undefined,
      });
    });

    it("does not fire when the agent-image import create fails", async () => {
      mockCreatePersona.mockRejectedValueOnce(new Error("create failed"));
      const { container } = render(<AgentsView />);
      const input = container.querySelector<HTMLInputElement>(
        'input[type="file"][accept*="image/png"]',
      );

      fireEvent.change(input as HTMLInputElement, {
        target: { files: [agentImageFixtureFile()] },
      });
      await userEvent.click(
        await screen.findByRole("button", { name: "importDialog.import" }),
      );
      await screen.findByRole("heading", { name: "imageImport.description" });

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "imageImport.add" }));

      await waitFor(() => expect(toast.error).toHaveBeenCalled());
      expect(mockTrackAgentCreateCompleted).not.toHaveBeenCalled();
    });
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
