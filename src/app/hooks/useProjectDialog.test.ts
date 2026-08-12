import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { useProjectDialog } from "./useProjectDialog";

function mockProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "project-1",
    path: "/tmp/project-1.yaml",
    name: "Project One",
    description: "",
    prompt: "",
    icon: "",
    color: "",
    workingDirs: [],
    projectWorkspaces: [],
    useWorktrees: false,
    order: 0,
    archivedAt: null,
    ...overrides,
  };
}

describe("useProjectDialog", () => {
  it("runs saved and created callbacks for newly created projects", () => {
    const onProjectCreated = vi.fn();
    const onProjectSaved = vi.fn();
    const onCreated = vi.fn();
    const project = mockProject();
    const { result } = renderHook(() =>
      useProjectDialog({ onProjectCreated, onProjectSaved }),
    );

    act(() => {
      result.current.openCreateProjectDialog({ onCreated });
    });
    act(() => {
      result.current.handleProjectCreated(project);
    });

    expect(onProjectSaved).toHaveBeenCalledWith(project);
    expect(onProjectCreated).toHaveBeenCalledWith(project);
    expect(onCreated).toHaveBeenCalledWith(project.id);
  });

  it("only runs the saved callback for edited projects", () => {
    const onProjectCreated = vi.fn();
    const onProjectSaved = vi.fn();
    const project = mockProject();
    const savedProject = mockProject({ name: "Renamed Project" });
    const { result } = renderHook(() =>
      useProjectDialog({ onProjectCreated, onProjectSaved }),
    );

    act(() => {
      result.current.openEditProjectDialog(project);
    });
    act(() => {
      result.current.handleProjectCreated(savedProject);
    });

    expect(onProjectSaved).toHaveBeenCalledWith(savedProject);
    expect(onProjectCreated).not.toHaveBeenCalled();
  });
});
