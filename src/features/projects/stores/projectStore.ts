import { create } from "zustand";
import {
  listProjects,
  createProject,
  updateProject,
  deleteProject,
  normalizeProjectWorkspaces,
  reorderProjects as apiReorderProjects,
  type ProjectInfo,
  type ProjectWorkspace,
} from "../api/projects";

const PROJECT_CACHE_STORAGE_KEY = "goose:projects";

function normalizeCachedProject(project: ProjectInfo): ProjectInfo {
  const rawProject = project as Partial<ProjectInfo>;
  const projectWorkspaces = normalizeProjectWorkspaces(
    rawProject.projectWorkspaces,
    rawProject.workingDirs ?? [],
    rawProject.useWorktrees ?? false,
  );
  return {
    ...project,
    projectWorkspaces,
    workingDirs: projectWorkspaces.map((workspace) => workspace.path),
  };
}

function loadCachedProjects(): ProjectInfo[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = window.localStorage.getItem(PROJECT_CACHE_STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed)
      ? (parsed as ProjectInfo[]).map(normalizeCachedProject)
      : [];
  } catch {
    return [];
  }
}

function persistProjects(projects: ProjectInfo[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      PROJECT_CACHE_STORAGE_KEY,
      JSON.stringify(projects),
    );
  } catch {
    // localStorage may be unavailable
  }
}

export interface ProjectStore {
  projects: ProjectInfo[];
  loading: boolean;
  /** True once fetchProjects has succeeded this app session; the
   *  localStorage seed alone never sets it. */
  hasFetchedProjects: boolean;
  activeProjectId: string | null;

  // Actions
  fetchProjects: () => Promise<void>;
  replaceProjectsFromBackend: (projects: ProjectInfo[]) => void;
  addProject: (
    name: string,
    description: string,
    prompt: string,
    icon: string,
    color: string,
    workingDirs: string[],
    useWorktrees: boolean,
    projectWorkspaces?: ProjectWorkspace[],
  ) => Promise<ProjectInfo>;
  editProject: (
    id: string,
    name: string,
    description: string,
    prompt: string,
    icon: string,
    color: string,
    workingDirs: string[],
    useWorktrees: boolean,
    projectWorkspaces?: ProjectWorkspace[],
  ) => Promise<ProjectInfo>;
  removeProject: (id: string) => Promise<void>;
  reorderProjects: (
    fromId: string,
    toId: string,
    placement?: "before" | "after",
  ) => void;
  setActiveProject: (id: string | null) => void;
  getActiveProject: () => ProjectInfo | null;
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: loadCachedProjects(),
  loading: false,
  hasFetchedProjects: false,
  activeProjectId: null,

  fetchProjects: async () => {
    set({ loading: true });
    try {
      const projects = await listProjects();
      get().replaceProjectsFromBackend(projects);
    } catch {
      set({ loading: false });
    }
  },

  replaceProjectsFromBackend: (projects) => {
    set({ projects, loading: false, hasFetchedProjects: true });
    persistProjects(projects);
  },

  addProject: async (
    name,
    description,
    prompt,
    icon,
    color,
    workingDirs,
    useWorktrees,
    projectWorkspaces,
  ) => {
    const project = await createProject(
      name,
      description,
      prompt,
      icon,
      color,
      workingDirs,
      useWorktrees,
      projectWorkspaces,
    );
    set((state) => ({ projects: [...state.projects, project] }));
    persistProjects(get().projects);
    return project;
  },

  editProject: async (
    id,
    name,
    description,
    prompt,
    icon,
    color,
    workingDirs,
    useWorktrees,
    projectWorkspaces,
  ) => {
    const existing = get().projects.find((p) => p.id === id);
    if (!existing) throw new Error(`Project ${id} not found`);
    const project = await updateProject(existing, {
      name,
      description,
      prompt,
      icon,
      color,
      workingDirs,
      useWorktrees,
      projectWorkspaces,
    });
    set((state) => ({
      projects: state.projects.map((p) => (p.id === id ? project : p)),
    }));
    persistProjects(get().projects);
    return project;
  },

  removeProject: async (id) => {
    await deleteProject(id);
    set((state) => ({
      projects: state.projects.filter((p) => p.id !== id),
      activeProjectId:
        state.activeProjectId === id ? null : state.activeProjectId,
    }));
    persistProjects(get().projects);
  },

  reorderProjects: (fromId, toId, placement = "before") => {
    set((state) => {
      const projects = [...state.projects];
      const fromIndex = projects.findIndex((p) => p.id === fromId);
      const toIndex = projects.findIndex((p) => p.id === toId);
      if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex)
        return state;
      const [moved] = projects.splice(fromIndex, 1);
      const targetIndexAfterRemoval =
        fromIndex < toIndex ? toIndex - 1 : toIndex;
      const insertAt =
        placement === "after"
          ? targetIndexAfterRemoval + 1
          : targetIndexAfterRemoval;
      projects.splice(insertAt, 0, moved);
      // Update order fields so views sorting by .order stay consistent
      for (let i = 0; i < projects.length; i++) {
        projects[i] = { ...projects[i], order: i };
      }
      return { projects };
    });
    const projects = get().projects;
    persistProjects(projects);
    void apiReorderProjects(projects.map((p, i) => [p.id, i]));
  },

  setActiveProject: (id) => set({ activeProjectId: id }),

  getActiveProject: () => {
    const { projects, activeProjectId } = get();
    return projects.find((p) => p.id === activeProjectId) ?? null;
  },
}));
