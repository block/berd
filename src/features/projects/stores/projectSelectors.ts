import type { ProjectStore } from "./projectStore";

export const selectProjects = (state: ProjectStore) => state.projects;

export const selectHasFetchedProjects = (state: ProjectStore) =>
  state.hasFetchedProjects;
