import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAgentStore } from "../../stores/agentStore";
import type { Persona } from "@/shared/types/agents";

// ── mocks ────────────────────────────────────────────────────────────

const avatarApiMocks = vi.hoisted(() => ({
  deleteUserAvatar: vi.fn(),
}));

vi.mock("@/shared/api/avatars", () => avatarApiMocks);

vi.mock("@/shared/api/agents", () => ({
  listAgentGallery: vi.fn().mockResolvedValue({ personas: [], drafts: [] }),
  createPersona: vi.fn().mockResolvedValue({
    id: "new-id",
    displayName: "Test",
    systemPrompt: "You are helpful.",
    isBuiltin: false,
    writable: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  }),
  updatePersona: vi.fn().mockResolvedValue({
    id: "test-id",
    displayName: "Updated",
    systemPrompt: "Updated prompt",
    isBuiltin: false,
    writable: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  }),
  deletePersona: vi.fn().mockResolvedValue(undefined),
  refreshAgentGallery: vi.fn().mockResolvedValue({ personas: [], drafts: [] }),
}));

// Import the mocked module so we can inspect/adjust calls
import * as api from "@/shared/api/agents";

// Import the hook after mocks are set up
import { usePersonas } from "../usePersonas";

// ── helpers ──────────────────────────────────────────────────────────

function gallery(
  personas: Persona[],
  drafts: api.AgentGalleryListing["drafts"] = [],
): api.AgentGalleryListing {
  return { personas, drafts };
}

function makePersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: crypto.randomUUID(),
    displayName: "Test Persona",
    systemPrompt: "You are helpful.",
    isBuiltin: false,
    writable: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── tests ────────────────────────────────────────────────────────────

describe("usePersonas", () => {
  beforeEach(() => {
    // Re-establish default mock implementations (clearAllMocks would wipe them)
    avatarApiMocks.deleteUserAvatar.mockReset().mockResolvedValue(undefined);
    vi.mocked(api.listAgentGallery).mockReset().mockResolvedValue(gallery([]));
    vi.mocked(api.createPersona).mockReset().mockResolvedValue({
      id: "new-id",
      displayName: "Test",
      systemPrompt: "You are helpful.",
      isBuiltin: false,
      writable: true,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    vi.mocked(api.updatePersona).mockReset().mockResolvedValue({
      id: "test-id",
      displayName: "Updated",
      systemPrompt: "Updated prompt",
      isBuiltin: false,
      writable: true,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    vi.mocked(api.deletePersona).mockReset().mockResolvedValue(undefined);
    vi.mocked(api.refreshAgentGallery)
      .mockReset()
      .mockResolvedValue(gallery([]));

    useAgentStore.setState({
      personas: [],
      personasLoading: false,
      draftSources: [],
      agents: [],
      agentsLoading: false,
      activeAgentId: null,
      isLoading: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── loading ────────────────────────────────────────────────────────

  describe("loading personas", () => {
    it("loads personas and drafts on mount via listAgentGallery()", async () => {
      const personas = [makePersona({ id: "p1" }), makePersona({ id: "p2" })];
      const draft = {
        type: "agent" as const,
        path: "/Users/x/.agents/agents/untitled-agent-1.md",
        name: "Untitled agent 1",
        description: "Draft",
        content: "Draft in progress.",
        global: true,
        writable: true,
        properties: { draft: true, builderSessionId: "sess-1" },
      };
      vi.mocked(api.listAgentGallery).mockResolvedValueOnce(
        gallery(personas, [draft]),
      );

      const { result } = renderHook(() => usePersonas());

      await waitFor(() => {
        expect(api.listAgentGallery).toHaveBeenCalledTimes(1);
      });

      await waitFor(() => {
        expect(result.current.personas).toEqual(personas);
      });
      expect(useAgentStore.getState().draftSources).toEqual([draft]);
    });

    it("sets loading state correctly", async () => {
      // Create a deferred promise to control timing
      let resolveList!: (value: api.AgentGalleryListing) => void;
      vi.mocked(api.listAgentGallery).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveList = resolve;
          }),
      );

      const { result } = renderHook(() => usePersonas());

      // Should be loading while the API call is in flight
      await waitFor(() => {
        expect(result.current.isLoading).toBe(true);
      });

      // Resolve the API call
      await act(async () => {
        resolveList(gallery([]));
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
    });
  });

  // ── CRUD operations ────────────────────────────────────────────────

  describe("CRUD operations", () => {
    it("createPersona calls API and adds to store", async () => {
      const newPersona = {
        id: "new-id",
        displayName: "Test",
        systemPrompt: "You are helpful.",
        isBuiltin: false,
        writable: true,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };
      vi.mocked(api.createPersona).mockResolvedValueOnce(newPersona);

      const { result } = renderHook(() => usePersonas());

      // Wait for initial load to fully complete
      await waitFor(() => {
        expect(api.listAgentGallery).toHaveBeenCalledTimes(1);
        expect(result.current.isLoading).toBe(false);
      });

      let created: Persona | undefined;
      await act(async () => {
        created = await result.current.createPersona({
          displayName: "Test",
          systemPrompt: "You are helpful.",
        });
      });

      expect(api.createPersona).toHaveBeenCalledWith({
        displayName: "Test",
        systemPrompt: "You are helpful.",
      });
      expect(created).toEqual(newPersona);
      expect(result.current.personas).toContainEqual(newPersona);
    });

    it("updatePersona calls API and updates store", async () => {
      const existing = makePersona({ id: "test-id", displayName: "Old" });
      // Return existing persona from initial load so the store has it
      vi.mocked(api.listAgentGallery).mockResolvedValueOnce(
        gallery([existing]),
      );

      const updated = {
        id: "test-id",
        displayName: "Updated",
        systemPrompt: "Updated prompt",
        isBuiltin: false,
        writable: true,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };
      vi.mocked(api.updatePersona).mockResolvedValueOnce(updated);

      const { result } = renderHook(() => usePersonas());

      // Wait for initial load to populate store
      await waitFor(() => {
        expect(result.current.personas).toHaveLength(1);
      });

      await act(async () => {
        await result.current.updatePersona(existing, {
          displayName: "Updated",
        });
      });

      expect(api.updatePersona).toHaveBeenCalledWith(existing, {
        displayName: "Updated",
      });
      expect(
        result.current.personas.find((p) => p.id === "test-id")?.displayName,
      ).toBe("Updated");
    });

    it("preserves a replaced gloopie in the library after its final agent reference changes", async () => {
      const existing = makePersona({
        id: "test-id",
        avatar: "user-avatar:shared",
      });
      const shared = makePersona({
        id: "shared-id",
        avatar: "user-avatar:shared",
      });
      vi.mocked(api.listAgentGallery).mockResolvedValueOnce(
        gallery([existing, shared]),
      );
      vi.mocked(api.updatePersona).mockResolvedValue({
        ...existing,
        avatar: "user-avatar:new",
      });
      const { result } = renderHook(() => usePersonas());
      await waitFor(() => expect(result.current.personas).toHaveLength(2));

      await act(async () => {
        await result.current.updatePersona(existing, {
          avatar: "user-avatar:new",
        });
      });
      expect(avatarApiMocks.deleteUserAvatar).not.toHaveBeenCalled();

      vi.mocked(api.updatePersona).mockResolvedValue({
        ...shared,
        avatar: null,
      });
      await act(async () => {
        await result.current.updatePersona(shared, { avatar: null });
      });
      expect(avatarApiMocks.deleteUserAvatar).not.toHaveBeenCalled();
    });

    it("preserves gloopies displaced by overlapping updates", async () => {
      const existing = makePersona({ id: "test-id", avatar: "user-avatar:a" });
      vi.mocked(api.listAgentGallery).mockResolvedValueOnce(
        gallery([existing]),
      );
      const first = makePersona({ id: "test-id", avatar: "user-avatar:b" });
      const second = makePersona({ id: "test-id", avatar: "user-avatar:c" });
      const firstResult = vi.fn<() => Promise<Persona>>();
      let resolveFirst!: (persona: Persona) => void;
      let resolveSecond!: (persona: Persona) => void;
      firstResult
        .mockImplementationOnce(
          () => new Promise((resolve) => (resolveFirst = resolve)),
        )
        .mockImplementationOnce(
          () => new Promise((resolve) => (resolveSecond = resolve)),
        );
      vi.mocked(api.updatePersona).mockImplementation(firstResult);
      const { result } = renderHook(() => usePersonas());
      await waitFor(() => expect(result.current.personas).toHaveLength(1));

      const updateOne = result.current.updatePersona(existing, {
        avatar: "user-avatar:b",
      });
      const updateTwo = result.current.updatePersona(existing, {
        avatar: "user-avatar:c",
      });
      await act(async () => {
        resolveFirst(first);
        await updateOne;
      });
      await act(async () => {
        resolveSecond(second);
        await updateTwo;
      });

      expect(avatarApiMocks.deleteUserAvatar).not.toHaveBeenCalled();
    });

    it("deletePersona calls API and removes from store", async () => {
      const existing = makePersona({ id: "del-id" });
      // Return existing persona from initial load so the store has it
      vi.mocked(api.listAgentGallery).mockResolvedValueOnce(
        gallery([existing]),
      );

      const { result } = renderHook(() => usePersonas());

      // Wait for initial load to populate store
      await waitFor(() => {
        expect(result.current.personas).toHaveLength(1);
      });

      await act(async () => {
        await result.current.deletePersona("del-id");
      });

      expect(api.deletePersona).toHaveBeenCalledWith("del-id");
      expect(
        result.current.personas.find((p) => p.id === "del-id"),
      ).toBeUndefined();
    });

    it("preserves a gloopie in the library after its final agent is deleted", async () => {
      const first = makePersona({
        id: "first",
        avatar: "user-avatar:shared",
      });
      const second = makePersona({
        id: "second",
        avatar: "user-avatar:shared",
      });
      vi.mocked(api.listAgentGallery).mockResolvedValueOnce(
        gallery([first, second]),
      );
      const { result } = renderHook(() => usePersonas());
      await waitFor(() => expect(result.current.personas).toHaveLength(2));

      await act(async () => {
        await result.current.deletePersona("first");
      });
      expect(avatarApiMocks.deleteUserAvatar).not.toHaveBeenCalled();

      await act(async () => {
        await result.current.deletePersona("second");
      });
      expect(avatarApiMocks.deleteUserAvatar).not.toHaveBeenCalled();
    });
  });

  // ── refresh ────────────────────────────────────────────────────────

  describe("refresh", () => {
    it("refreshFromDisk calls refreshAgentGallery() API", async () => {
      const refreshed = [makePersona({ id: "refreshed-1" })];
      vi.mocked(api.refreshAgentGallery).mockResolvedValueOnce(
        gallery(refreshed),
      );

      const { result } = renderHook(() => usePersonas());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await act(async () => {
        await result.current.refreshFromDisk();
      });

      expect(api.refreshAgentGallery).toHaveBeenCalled();
      expect(result.current.personas).toEqual(refreshed);
    });

    it("does not start overlapping refresh requests", async () => {
      let resolveRefresh!: (value: api.AgentGalleryListing) => void;
      vi.mocked(api.refreshAgentGallery).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      );

      const { result } = renderHook(() => usePersonas());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const firstRefresh = result.current.refreshFromDisk();
      const secondRefresh = result.current.refreshFromDisk();

      expect(api.refreshAgentGallery).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveRefresh(gallery([]));
        await firstRefresh;
        await secondRefresh;
      });
    });

    it("ignores stale refresh results that started before a mutation", async () => {
      const stalePersona = makePersona({ id: "stale" });
      const createdPersona = makePersona({ id: "created" });
      let resolveRefresh!: (value: api.AgentGalleryListing) => void;
      vi.mocked(api.refreshAgentGallery).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      );
      vi.mocked(api.createPersona).mockResolvedValueOnce(createdPersona);

      const { result } = renderHook(() => usePersonas());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const refresh = result.current.refreshFromDisk();
      await act(async () => {
        await result.current.createPersona({
          displayName: "Created",
          systemPrompt: "Created prompt.",
        });
      });

      await act(async () => {
        resolveRefresh(gallery([stalePersona]));
        await refresh;
      });

      expect(result.current.personas).toEqual([createdPersona]);
    });
  });
});
