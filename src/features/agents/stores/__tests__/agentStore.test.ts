import { afterEach, describe, it, expect, beforeEach } from "vitest";
import { useAgentStore } from "../agentStore";
import type { Persona, Agent } from "@/shared/types/agents";
import type {
  AgentGalleryListing,
  AgentSourceEntry,
} from "@/shared/api/agents";

// ── fixtures ──────────────────────────────────────────────────────────

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

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: crypto.randomUUID(),
    name: "Test Agent",
    provider: "goose",
    model: "claude-sonnet-4",
    connectionType: "builtin",
    status: "online",
    isBuiltin: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── tests ─────────────────────────────────────────────────────────────

describe("agentStore", () => {
  beforeEach(() => {
    useAgentStore.setState({
      personas: [],
      personasLoading: false,
      draftSources: [],
      galleryRevision: 0,
      galleryMutationsInFlight: 0,
      galleryRefreshGeneration: 0,
      agents: [],
      agentsLoading: false,
      activeAgentId: null,
      isLoading: false,
    });
  });

  // ── initial state ─────────────────────────────────────────────────

  it("has empty personas and agents initially", () => {
    const state = useAgentStore.getState();
    expect(state.personas).toEqual([]);
    expect(state.agents).toEqual([]);
  });

  // ── persona CRUD ──────────────────────────────────────────────────

  it("setPersonas replaces personas", () => {
    const p1 = makePersona({ id: "p1" });
    const p2 = makePersona({ id: "p2" });
    useAgentStore.getState().setPersonas([p1, p2]);
    expect(useAgentStore.getState().personas).toEqual([p1, p2]);
  });

  it("addPersona appends a persona", () => {
    const p = makePersona();
    useAgentStore.getState().addPersona(p);
    expect(useAgentStore.getState().personas).toHaveLength(1);
    expect(useAgentStore.getState().personas[0].id).toBe(p.id);
  });

  it("updatePersona updates the correct persona", () => {
    const p = makePersona({ id: "up1", displayName: "Old" });
    useAgentStore.getState().setPersonas([p]);
    useAgentStore.getState().updatePersona("up1", { displayName: "New" });
    expect(useAgentStore.getState().personas[0].displayName).toBe("New");
  });

  it("removePersona removes the correct persona", () => {
    const p1 = makePersona({ id: "keep" });
    const p2 = makePersona({ id: "remove" });
    useAgentStore.getState().setPersonas([p1, p2]);
    useAgentStore.getState().removePersona("remove");
    expect(useAgentStore.getState().personas).toHaveLength(1);
    expect(useAgentStore.getState().personas[0].id).toBe("keep");
  });

  // ── agent CRUD ────────────────────────────────────────────────────

  it("setAgents replaces agents", () => {
    const a = makeAgent();
    useAgentStore.getState().setAgents([a]);
    expect(useAgentStore.getState().agents).toEqual([a]);
  });

  it("addAgent appends an agent", () => {
    const a = makeAgent();
    useAgentStore.getState().addAgent(a);
    expect(useAgentStore.getState().agents).toHaveLength(1);
  });

  it("updateAgent updates the correct agent", () => {
    const a = makeAgent({ id: "ua1", name: "Old" });
    useAgentStore.getState().setAgents([a]);
    useAgentStore.getState().updateAgent("ua1", { name: "New" });
    expect(useAgentStore.getState().agents[0].name).toBe("New");
  });

  it("removeAgent removes the correct agent", () => {
    const a1 = makeAgent({ id: "keep" });
    const a2 = makeAgent({ id: "remove" });
    useAgentStore.getState().setAgents([a1, a2]);
    useAgentStore.getState().removeAgent("remove");
    expect(useAgentStore.getState().agents).toHaveLength(1);
    expect(useAgentStore.getState().agents[0].id).toBe("keep");
  });

  // ── active agent ──────────────────────────────────────────────────

  it("setActiveAgent updates activeAgentId", () => {
    useAgentStore.getState().setActiveAgent("a1");
    expect(useAgentStore.getState().activeAgentId).toBe("a1");
  });

  it("getActiveAgent returns correct agent or null", () => {
    expect(useAgentStore.getState().getActiveAgent()).toBeNull();

    const a = makeAgent({ id: "active-1" });
    useAgentStore.getState().setAgents([a]);
    useAgentStore.getState().setActiveAgent("active-1");
    expect(useAgentStore.getState().getActiveAgent()).toEqual(a);
  });

  // ── helpers ───────────────────────────────────────────────────────

  it("getPersonaById returns correct persona", () => {
    const p = makePersona({ id: "find-me" });
    useAgentStore.getState().setPersonas([p]);
    expect(useAgentStore.getState().getPersonaById("find-me")).toEqual(p);
    expect(useAgentStore.getState().getPersonaById("nope")).toBeUndefined();
  });

  it("getAgentsByPersona filters correctly", () => {
    const a1 = makeAgent({ id: "a1", personaId: "p1" });
    const a2 = makeAgent({ id: "a2", personaId: "p2" });
    const a3 = makeAgent({ id: "a3", personaId: "p1" });
    useAgentStore.getState().setAgents([a1, a2, a3]);
    const result = useAgentStore.getState().getAgentsByPersona("p1");
    expect(result).toHaveLength(2);
    expect(result.map((a) => a.id).sort()).toEqual(["a1", "a3"]);
  });

  it("getBuiltinPersonas returns only builtins", () => {
    useAgentStore
      .getState()
      .setPersonas([
        makePersona({ id: "b", isBuiltin: true, writable: false }),
        makePersona({ id: "c", isBuiltin: false }),
      ]);
    const builtins = useAgentStore.getState().getBuiltinPersonas();
    expect(builtins).toHaveLength(1);
    expect(builtins[0].id).toBe("b");
  });

  it("getCustomPersonas returns only writable personas", () => {
    useAgentStore
      .getState()
      .setPersonas([
        makePersona({ id: "b", isBuiltin: true, writable: false }),
        makePersona({ id: "c", isBuiltin: false }),
        makePersona({ id: "readonly", isBuiltin: false, writable: false }),
      ]);
    const custom = useAgentStore.getState().getCustomPersonas();
    expect(custom).toHaveLength(1);
    expect(custom[0].id).toBe("c");
  });

  // ── gallery fence ─────────────────────────────────────────────────

  describe("gallery fence", () => {
    const draft: AgentSourceEntry = {
      type: "agent",
      path: "/agents/draft.md",
      name: "Untitled agent",
      description: "Draft",
      content: "",
      properties: { draft: true },
      writable: true,
      global: true,
    };

    function deferredListing() {
      let resolve: (listing: AgentGalleryListing) => void = () => {};
      const promise = new Promise<AgentGalleryListing>((r) => {
        resolve = r;
      });
      return { fetch: () => promise, resolve };
    }

    it("applies a snapshot when nothing changed while it was in flight", async () => {
      const listing = deferredListing();
      const pending = useAgentStore.getState().refreshGallery(listing.fetch);
      listing.resolve({
        personas: [makePersona({ id: "p1" })],
        drafts: [draft],
      });

      await expect(pending).resolves.toBe(true);
      expect(useAgentStore.getState().personas.map((p) => p.id)).toEqual([
        "p1",
      ]);
      expect(useAgentStore.getState().draftSources).toEqual([draft]);
    });

    it("drops a snapshot that started before a mutation and resolved after it", async () => {
      useAgentStore.setState({ draftSources: [draft] });
      const stale = deferredListing();
      const pending = useAgentStore.getState().refreshGallery(stale.fetch);

      // The user deletes the draft while the refresh is still in flight.
      await useAgentStore.getState().mutateGallery(async () => {
        useAgentStore.getState().removeDraftSource(draft.path);
      });
      expect(useAgentStore.getState().draftSources).toEqual([]);

      // The old photo arrives, still showing the draft. It must not win.
      stale.resolve({ personas: [], drafts: [draft] });
      await expect(pending).resolves.toBe(false);
      expect(useAgentStore.getState().draftSources).toEqual([]);
    });

    it("drops a snapshot that resolves while a mutation is still in flight", async () => {
      const listing = deferredListing();
      const pending = useAgentStore.getState().refreshGallery(listing.fetch);

      let finishMutation: () => void = () => {};
      const mutation = useAgentStore.getState().mutateGallery(
        () =>
          new Promise<void>((r) => {
            finishMutation = r;
          }),
      );
      listing.resolve({ personas: [], drafts: [draft] });
      await expect(pending).resolves.toBe(false);
      expect(useAgentStore.getState().draftSources).toEqual([]);

      finishMutation();
      await mutation;
      expect(useAgentStore.getState().galleryMutationsInFlight).toBe(0);
    });

    it("releases the fence when a mutation throws", async () => {
      await expect(
        useAgentStore.getState().mutateGallery(async () => {
          throw new Error("delete failed");
        }),
      ).rejects.toThrow("delete failed");
      expect(useAgentStore.getState().galleryMutationsInFlight).toBe(0);

      const listing = deferredListing();
      const pending = useAgentStore.getState().refreshGallery(listing.fetch);
      listing.resolve({ personas: [], drafts: [draft] });
      await expect(pending).resolves.toBe(true);
    });

    it("drops an older snapshot that resolves after a newer one (latest wins)", async () => {
      // The draft file was removed outside the app between two refreshes.
      // The newer listing (no draft) lands first; the older one (still has
      // the draft) must not put the card back.
      const older = deferredListing();
      const newer = deferredListing();
      const pendingOlder = useAgentStore.getState().refreshGallery(older.fetch);
      const pendingNewer = useAgentStore.getState().refreshGallery(newer.fetch);

      newer.resolve({ personas: [], drafts: [] });
      await expect(pendingNewer).resolves.toBe(true);
      older.resolve({ personas: [], drafts: [draft] });
      await expect(pendingOlder).resolves.toBe(false);

      expect(useAgentStore.getState().draftSources).toEqual([]);
    });
  });
});

describe("agentStore.setProviders", () => {
  beforeEach(() => {
    localStorage.clear();
    useAgentStore.setState({
      providers: [],
      providersLoading: false,
      selectedProvider: "claude-acp",
    });
    localStorage.setItem("goose:defaultProvider", "claude-acp");
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("does not overwrite stored provider during unvalidated hydration", () => {
    useAgentStore
      .getState()
      .setProviders([{ id: "goose", label: "Goose" }], false);

    expect(useAgentStore.getState().selectedProvider).toBe("claude-acp");
    expect(localStorage.getItem("goose:defaultProvider")).toBe("claude-acp");
  });

  it("falls back and persists when validated and provider is missing", () => {
    useAgentStore
      .getState()
      .setProviders([{ id: "goose", label: "Goose" }], true);

    expect(useAgentStore.getState().selectedProvider).toBe("goose");
    expect(localStorage.getItem("goose:defaultProvider")).toBe("goose");
  });

  it("keeps valid provider during validated hydration", () => {
    useAgentStore.getState().setProviders(
      [
        { id: "goose", label: "Goose" },
        { id: "claude-acp", label: "Claude Code" },
      ],
      true,
    );

    expect(useAgentStore.getState().selectedProvider).toBe("claude-acp");
    expect(localStorage.getItem("goose:defaultProvider")).toBe("claude-acp");
  });
});
