import { create } from "zustand";
import type { Persona, Agent } from "@/shared/types/agents";
import type { AcpProvider } from "@/shared/api/acp";
import type {
  AgentGalleryListing,
  AgentSourceEntry,
} from "@/shared/api/agents";
import { canEditPersona } from "@/features/agents/lib/personaPresentation";

const PROVIDER_STORAGE_KEY = "goose:defaultProvider";
const FALLBACK_PROVIDER = "goose";

export function getStoredProvider(providers: AcpProvider[] = []): string {
  try {
    const storedProvider =
      localStorage.getItem(PROVIDER_STORAGE_KEY) ?? FALLBACK_PROVIDER;

    if (
      providers.length === 0 ||
      providers.some((provider) => provider.id === storedProvider)
    ) {
      return storedProvider;
    }

    return providers[0]?.id ?? FALLBACK_PROVIDER;
  } catch {
    return providers[0]?.id ?? FALLBACK_PROVIDER;
  }
}

function persistProvider(providerId: string): void {
  try {
    localStorage.setItem(PROVIDER_STORAGE_KEY, providerId);
  } catch {
    // localStorage may be unavailable
  }
}

interface AgentStoreState {
  // Personas
  personas: Persona[];
  personasLoading: boolean;
  // Builder drafts as listed on disk; the gallery's draft cards come from here.
  draftSources: AgentSourceEntry[];
  // Gallery fence. A disk snapshot is only applied if no gallery mutation
  // started or finished while it was in flight, so a slow refresh can never
  // resurrect something the user just deleted or promoted. Snapshots are also
  // latest-wins: an older listing that resolves after a newer one is dropped,
  // so a file removed outside the app cannot flicker back.
  galleryRevision: number;
  galleryMutationsInFlight: number;
  galleryRefreshGeneration: number;

  // Agents
  agents: Agent[];
  agentsLoading: boolean;

  // ACP Providers (cached)
  providers: AcpProvider[];
  providersLoading: boolean;

  // Selected provider (shared across all chat screens)
  selectedProvider: string;

  // Active agent for current chat
  activeAgentId: string | null;

  // General loading (for backwards compat)
  isLoading: boolean;
}

interface AgentStoreActions {
  // Persona CRUD
  setPersonas: (personas: Persona[]) => void;
  addPersona: (persona: Persona) => void;
  updatePersona: (id: string, updates: Partial<Persona>) => void;
  removePersona: (id: string) => void;
  setPersonasLoading: (loading: boolean) => void;
  setDraftSources: (drafts: AgentSourceEntry[]) => void;
  removeDraftSource: (path: string) => void;
  // Every writer of the gallery goes through one of these two. Direct
  // setPersonas/setDraftSources calls from a disk listing bypass the fence.
  refreshGallery: (
    fetchGallery: () => Promise<AgentGalleryListing>,
  ) => Promise<boolean>;
  mutateGallery: <T>(work: () => Promise<T> | T) => Promise<T>;

  // Agent CRUD
  setAgents: (agents: Agent[]) => void;
  addAgent: (agent: Agent) => void;
  updateAgent: (id: string, updates: Partial<Agent>) => void;
  removeAgent: (id: string) => void;
  setAgentsLoading: (loading: boolean) => void;

  // Provider management
  setProviders: (providers: AcpProvider[], validated?: boolean) => void;
  setProvidersLoading: (loading: boolean) => void;
  setSelectedProvider: (providerId: string, persist?: boolean) => void;

  // Active agent
  setActiveAgent: (id: string | null) => void;
  getActiveAgent: () => Agent | null;

  // Loading
  setLoading: (loading: boolean) => void;

  // Helpers
  getPersonaById: (id: string) => Persona | undefined;
  getAgentById: (id: string) => Agent | undefined;
  getAgentsByPersona: (personaId: string) => Agent[];
  getBuiltinPersonas: () => Persona[];
  getCustomPersonas: () => Persona[];
}

export type AgentStore = AgentStoreState & AgentStoreActions;

export const useAgentStore = create<AgentStore>((set, get) => ({
  // State
  personas: [],
  personasLoading: false,
  draftSources: [],
  galleryRevision: 0,
  galleryMutationsInFlight: 0,
  galleryRefreshGeneration: 0,
  agents: [],
  agentsLoading: false,
  providers: [],
  providersLoading: false,
  selectedProvider: getStoredProvider(),
  activeAgentId: null,
  isLoading: false,

  // Persona CRUD
  setPersonas: (personas) => set({ personas }),

  addPersona: (persona) =>
    set((state) => ({ personas: [...state.personas, persona] })),

  updatePersona: (id, updates) =>
    set((state) => ({
      personas: state.personas.map((p) =>
        p.id === id
          ? { ...p, ...updates, updatedAt: new Date().toISOString() }
          : p,
      ),
    })),

  removePersona: (id) =>
    set((state) => ({
      personas: state.personas.filter((p) => p.id !== id),
    })),

  setPersonasLoading: (personasLoading) => set({ personasLoading }),

  setDraftSources: (draftSources) => set({ draftSources }),

  removeDraftSource: (path) =>
    set((state) => ({
      draftSources: state.draftSources.filter((draft) => draft.path !== path),
    })),

  refreshGallery: async (fetchGallery) => {
    const generation = get().galleryRefreshGeneration + 1;
    set({ galleryRefreshGeneration: generation });
    const revisionAtStart = get().galleryRevision;
    const { personas, drafts } = await fetchGallery();
    const {
      galleryRevision,
      galleryMutationsInFlight,
      galleryRefreshGeneration,
    } = get();
    if (
      revisionAtStart !== galleryRevision ||
      galleryMutationsInFlight !== 0 ||
      generation !== galleryRefreshGeneration
    ) {
      return false;
    }
    set({ personas, draftSources: drafts });
    return true;
  },

  mutateGallery: async (work) => {
    set((state) => ({
      galleryRevision: state.galleryRevision + 1,
      galleryMutationsInFlight: state.galleryMutationsInFlight + 1,
    }));
    try {
      return await work();
    } finally {
      set((state) => ({
        galleryRevision: state.galleryRevision + 1,
        galleryMutationsInFlight: state.galleryMutationsInFlight - 1,
      }));
    }
  },

  // Agent CRUD
  setAgents: (agents) => set({ agents }),

  addAgent: (agent) => set((state) => ({ agents: [...state.agents, agent] })),

  updateAgent: (id, updates) =>
    set((state) => ({
      agents: state.agents.map((a) =>
        a.id === id
          ? { ...a, ...updates, updatedAt: new Date().toISOString() }
          : a,
      ),
    })),

  removeAgent: (id) =>
    set((state) => ({
      agents: state.agents.filter((a) => a.id !== id),
      activeAgentId: state.activeAgentId === id ? null : state.activeAgentId,
    })),

  setAgentsLoading: (agentsLoading) => set({ agentsLoading }),

  // Provider management
  setProviders: (providers, validated = true) => {
    const { selectedProvider } = get();
    const isValid = providers.some((p) => p.id === selectedProvider);
    if (!isValid && providers.length > 0 && validated) {
      const fallback = providers[0].id;
      persistProvider(fallback);
      set({ providers, selectedProvider: fallback });
    } else {
      set({ providers });
    }
  },
  setProvidersLoading: (providersLoading) => set({ providersLoading }),
  setSelectedProvider: (providerId, persist = true) => {
    if (persist) {
      persistProvider(providerId);
    }
    set({ selectedProvider: providerId });
  },

  // Active agent
  setActiveAgent: (id) => set({ activeAgentId: id }),

  getActiveAgent: () => {
    const { activeAgentId, agents } = get();
    if (!activeAgentId) return null;
    return agents.find((a) => a.id === activeAgentId) ?? null;
  },

  // Loading
  setLoading: (isLoading) => set({ isLoading }),

  // Helpers
  getPersonaById: (id) => get().personas.find((p) => p.id === id),

  getAgentById: (id) => get().agents.find((a) => a.id === id),

  getAgentsByPersona: (personaId) =>
    get().agents.filter((a) => a.personaId === personaId),

  getBuiltinPersonas: () => get().personas.filter((p) => p.isBuiltin),

  getCustomPersonas: () => get().personas.filter(canEditPersona),
}));
