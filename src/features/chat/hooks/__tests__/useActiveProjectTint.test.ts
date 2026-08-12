import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { useProjectStore } from "@/features/projects/stores/projectStore";

import { useActiveProjectTint } from "../useActiveProjectTint";

const now = "2026-04-28T00:00:00.000Z";

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "session-1",
    title: "Project chat",
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    ...overrides,
  };
}

function project(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "project-1",
    path: "/tmp/project",
    name: "Project",
    description: "",
    prompt: "",
    icon: "folder",
    color: "blue",
    projectWorkspaces: [],
    workingDirs: [],
    useWorktrees: false,
    order: 0,
    archivedAt: null,
    ...overrides,
  };
}

describe("useActiveProjectTint", () => {
  beforeEach(() => {
    useChatSessionStore.setState({
      sessions: [],
      activeSessionId: null,
      isLoading: false,
      hasHydratedSessions: true,
      isRightRailOpen: false,
      activeWorkspaceBySession: {},
    });
    useProjectStore.setState({
      projects: [],
      loading: false,
      activeProjectId: null,
    });
  });

  it("returns null when there is no active project chat", () => {
    useChatSessionStore.setState({
      sessions: [session()],
      activeSessionId: "session-1",
    });

    const { result } = renderHook(() => useActiveProjectTint());

    expect(result.current).toBeNull();
  });

  it("maps a stored project tone to its CSS color variable", () => {
    useProjectStore.setState({ projects: [project({ color: "sage" })] });
    useChatSessionStore.setState({
      sessions: [session({ projectId: "project-1" })],
      activeSessionId: "session-1",
    });

    const { result } = renderHook(() => useActiveProjectTint());

    expect(result.current).toBe("var(--color-pill-sage)");
  });

  it("passes through legacy hex colors", () => {
    useProjectStore.setState({ projects: [project({ color: "#3b82f6" })] });
    useChatSessionStore.setState({
      sessions: [session({ projectId: "project-1" })],
      activeSessionId: "session-1",
    });

    const { result } = renderHook(() => useActiveProjectTint());

    expect(result.current).toBe("#3b82f6");
  });

  it("uses the default project tone when a project has no stored color", () => {
    useProjectStore.setState({ projects: [project({ color: "" })] });
    useChatSessionStore.setState({
      sessions: [session({ projectId: "project-1" })],
      activeSessionId: "session-1",
    });

    const { result } = renderHook(() => useActiveProjectTint());

    expect(result.current).toBe("var(--color-pill-olive)");
  });
});
