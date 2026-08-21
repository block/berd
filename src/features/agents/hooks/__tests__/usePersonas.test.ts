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
  listPersonas: vi.fn().mockResolvedValue([]),
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
  refreshPersonas: vi.fn().mockResolvedValue([]),
}));

// Import the mocked module so we can inspect/adjust calls
import * as api from "@/shared/api/agents";

// Import the hook after mocks are set up
import { usePersonas } from "../usePersonas";

// ── helpers ──────────────────────────────────────────────────────────

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
    vi.mocked(api.listPersonas).mockReset().mockResolvedValue([]);
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
    vi.mocked(api.refreshPersonas).mockReset().mockResolvedValue([]);

    useAgentStore.setState({
      personas: [],
      personasLoading: false,
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
    it("loads personas on mount via listPersonas()", async () => {
      const personas = [makePersona({ id: "p1" }), makePersona({ id: "p2" })];
      vi.mocked(api.listPersonas).mockResolvedValueOnce(personas);

      const { result } = renderHook(() => usePersonas());

      await waitFor(() => {
        expect(api.listPersonas).toHaveBeenCalledTimes(1);
      });

      await waitFor(() => {
        expect(result.current.personas).toEqual(personas);
      });
    });

    it("sets loading state correctly", async () => {
      // Create a deferred promise to control timing
      let resolveList!: (value: Persona[]) => void;
      vi.mocked(api.listPersonas).mockImplementationOnce(
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
        resolveList([]);
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
        expect(api.listPersonas).toHaveBeenCalledTimes(1);
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
      vi.mocked(api.listPersonas).mockResolvedValueOnce([existing]);

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
      vi.mocked(api.listPersonas).mockResolvedValueOnce([existing, shared]);
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
      vi.mocked(api.listPersonas).mockResolvedValueOnce([existing]);
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
      vi.mocked(api.listPersonas).mockResolvedValueOnce([existing]);

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
      vi.mocked(api.listPersonas).mockResolvedValueOnce([first, second]);
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
    it("refreshFromDisk calls refreshPersonas() API", async () => {
      const refreshed = [makePersona({ id: "refreshed-1" })];
      vi.mocked(api.refreshPersonas).mockResolvedValueOnce(refreshed);

      const { result } = renderHook(() => usePersonas());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await act(async () => {
        await result.current.refreshFromDisk();
      });

      expect(api.refreshPersonas).toHaveBeenCalled();
      expect(result.current.personas).toEqual(refreshed);
    });

    it("does not start overlapping refresh requests", async () => {
      let resolveRefresh!: (value: Persona[]) => void;
      vi.mocked(api.refreshPersonas).mockImplementationOnce(
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

      expect(api.refreshPersonas).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveRefresh([]);
        await firstRefresh;
        await secondRefresh;
      });
    });

    it("ignores stale refresh results that started before a mutation", async () => {
      const stalePersona = makePersona({ id: "stale" });
      const createdPersona = makePersona({ id: "created" });
      let resolveRefresh!: (value: Persona[]) => void;
      vi.mocked(api.refreshPersonas).mockImplementationOnce(
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
        resolveRefresh([stalePersona]);
        await refresh;
      });

      expect(result.current.personas).toEqual([createdPersona]);
    });
  });
});
