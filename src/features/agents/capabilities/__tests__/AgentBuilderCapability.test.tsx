import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";

const telemetryMocks = vi.hoisted(() => ({
  trackAgentCreateCompleted: vi.fn(),
  trackAgentEditCompleted: vi.fn(),
  trackAgentDeleteCompleted: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  createPersonaSource: vi.fn(),
  deletePersonaSource: vi.fn(),
  promotePersonaSource: vi.fn(),
  listPersonaSources: vi.fn(),
  readAgentSourceFile: vi.fn(),
  updatePersonaSource: vi.fn(),
  listAgentGallery: vi.fn(),
  hasRealAgentDescription: (description: string | null | undefined) => {
    const normalized = description?.trim().toLowerCase();
    return Boolean(
      normalized && normalized !== "agent" && normalized !== "draft",
    );
  },
}));

vi.mock("@/shared/api/agents", async (importOriginal) => ({
  ...apiMocks,
  // Pure mapper; the real one keeps the promotion path honest.
  agentSourceToPersona: (
    await importOriginal<typeof import("@/shared/api/agents")>()
  ).agentSourceToPersona,
}));

vi.mock("@/features/agents/lib/agentTelemetry", () => telemetryMocks);

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

vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => ({
    readyAgentIds: new Set(["goose"]),
    agentReadiness: new Map([["goose", "ready"]]),
    agentChecks: new Map(),
    loading: false,
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { AgentBuilderCapability } from "../AgentBuilderCapability";
import { saveDraftAgentSession } from "@/features/agents/lib/agentBuilderSession";
import { resetAgentBuilderSourceLifecycleForTests } from "@/features/agents/lib/agentBuilderSourceLifecycle";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import {
  useChatSessionStore,
  type ChatSession,
} from "@/features/chat/stores/chatSessionStore";
import type { AgentSourceEntry } from "@/shared/api/agents";
import type { Persona } from "@/shared/types/agents";

const existingAgentSource: AgentSourceEntry = {
  type: "agent",
  path: "/Users/x/.agents/agents/code-reviewer.md",
  name: "Code Reviewer",
  description: "Reviews code",
  content: "Review code carefully.",
  properties: { provider: "openai", model: "gpt-5" },
  writable: true,
} as AgentSourceEntry;

const builderSession: ChatSession = {
  id: "s1",
  title: "Code Reviewer",
  createdAt: "2026-06-09T00:00:00.000Z",
  updatedAt: "2026-06-09T00:00:00.000Z",
  messageCount: 0,
  intent: "build-agent",
  agentBuilderOpen: true,
  targetAgentPath: existingAgentSource.path,
  targetAgentSlug: "code-reviewer",
  targetAgentDraftState: null,
  targetAgentDraftSaved: true,
};

// The leave-builder "Keep" choice and closing the builder both funnel into
// saveDraftAgentSession, which runs the save handler the capability registers
// for the session — the rail's saveNow. These tests drive that whole chain
// with only the agents API mocked, pinning that a Keep save of an existing
// (non-draft) agent tracks exactly when it persists something.
describe("AgentBuilderCapability keep-save telemetry", () => {
  beforeEach(() => {
    telemetryMocks.trackAgentCreateCompleted.mockReset();
    telemetryMocks.trackAgentEditCompleted.mockReset();
    telemetryMocks.trackAgentDeleteCompleted.mockReset();
    apiMocks.createPersonaSource.mockReset();
    apiMocks.deletePersonaSource.mockReset();
    apiMocks.promotePersonaSource.mockReset();
    apiMocks.listPersonaSources.mockReset();
    apiMocks.readAgentSourceFile.mockReset();
    apiMocks.updatePersonaSource.mockReset();
    apiMocks.listAgentGallery.mockReset();
    apiMocks.listPersonaSources.mockResolvedValue([existingAgentSource]);
    apiMocks.readAgentSourceFile.mockImplementation(
      async (_path: string, fallback?: AgentSourceEntry) =>
        fallback ?? existingAgentSource,
    );
    // Mirrors the real API: the update response is the persisted entry the
    // telemetry is expected to report.
    apiMocks.updatePersonaSource.mockImplementation(
      async (_path: string, patch: Partial<AgentSourceEntry>) => ({
        ...existingAgentSource,
        ...patch,
        properties: {
          ...existingAgentSource.properties,
          ...(patch.properties ?? {}),
        },
      }),
    );
    apiMocks.listAgentGallery.mockResolvedValue({ personas: [], drafts: [] });
    resetAgentBuilderSourceLifecycleForTests();
    useAgentStore.setState({
      personas: [],
      personasLoading: false,
      draftSources: [],
      galleryRevision: 0,
      galleryMutationsInFlight: 0,
      providers: [],
    });
    useChatSessionStore.setState({
      sessions: [builderSession],
      hasHydratedSessions: true,
      hasMoreSessions: false,
    });
  });

  it("emits Edit Completed when a Keep save persists edits to an existing agent", async () => {
    renderWithProviders(<AgentBuilderCapability session={builderSession} />);
    const nameInput = await screen.findByLabelText(/agent name/i);
    expect(nameInput).toHaveValue("Code Reviewer");

    fireEvent.change(nameInput, { target: { value: "Code Reviewer Deluxe" } });
    expect(telemetryMocks.trackAgentEditCompleted).not.toHaveBeenCalled();

    await act(async () => {
      await saveDraftAgentSession("s1");
    });

    expect(apiMocks.updatePersonaSource).toHaveBeenCalledTimes(1);
    expect(apiMocks.updatePersonaSource).toHaveBeenCalledWith(
      existingAgentSource.path,
      { name: "Code Reviewer Deluxe" },
    );
    expect(telemetryMocks.trackAgentEditCompleted).toHaveBeenCalledTimes(1);
    expect(telemetryMocks.trackAgentEditCompleted).toHaveBeenCalledWith({
      provider: "openai",
      model: "gpt-5",
    });
    expect(telemetryMocks.trackAgentCreateCompleted).not.toHaveBeenCalled();
  });

  it("persists nothing and emits nothing for a Keep save with no pending edits", async () => {
    renderWithProviders(<AgentBuilderCapability session={builderSession} />);
    const nameInput = await screen.findByLabelText(/agent name/i);
    expect(nameInput).toHaveValue("Code Reviewer");

    await act(async () => {
      await saveDraftAgentSession("s1");
    });

    expect(apiMocks.updatePersonaSource).not.toHaveBeenCalled();
    expect(telemetryMocks.trackAgentEditCompleted).not.toHaveBeenCalled();
    expect(telemetryMocks.trackAgentCreateCompleted).not.toHaveBeenCalled();
  });

  it("applies the disk refresh that follows a save, through the real gallery fence", async () => {
    // The optimistic store seed runs as a gallery mutation; the follow-up
    // listing must start after that mutation releases the fence, or the fence
    // would reject it and the gallery would stay on the optimistic copy.
    const fromDisk: Persona = {
      id: existingAgentSource.path,
      displayName: "Code Reviewer (as listed on disk)",
      systemPrompt: existingAgentSource.content,
      isBuiltin: false,
      writable: true,
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    };
    apiMocks.listAgentGallery.mockResolvedValue({
      personas: [fromDisk],
      drafts: [],
    });

    renderWithProviders(
      <AgentBuilderCapability
        session={builderSession}
        onAgentBuilderCompleted={vi.fn()}
      />,
    );
    await screen.findByLabelText(/agent name/i);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(apiMocks.listAgentGallery).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(useAgentStore.getState().personas).toEqual([fromDisk]);
    });
    expect(useAgentStore.getState().galleryMutationsInFlight).toBe(0);
  });
});
