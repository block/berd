import { z } from "zod/v4";

import { defineCommand } from "../types";

const getProjectSchema = z
  .object({
    project_id: z.string().describe("Id of the project to read."),
  })
  .strict();

interface GetProjectResult {
  project_id: string;
  name: string;
  description: string;
  instructions: string;
  working_dirs: string[];
  workspaces: Array<{
    path: string;
    startup_mode:
      | "none"
      | "branch"
      | "worktree"
      | "ask-worktree"
      | "auto-worktree";
  }>;
  archived: boolean;
  session_count: number;
  chat_groups: Array<{
    group_id: string;
    name: string;
    session_ids: string[];
  }>;
}

export const getProjectCommand = defineCommand({
  effect: "read",
  visibility: "none",
  destructive: false,
  summary: "Read one project's details",
  description:
    "Read one project's details (instructions, working directories, per-workspace startup modes, chat groups, session count); " +
    "does not change anything on screen.",
  helpFooter: `Example:
  berdctl project get --project-id <project-id> --json

Result:
  {"project_id": "...", "name": "...", "description": "...",
   "instructions": "...", "working_dirs": ["..."], "workspaces": [
     {"path": "...", "startup_mode": "worktree"}
   ], "archived": false, "session_count": 4, "chat_groups": [
     {"group_id": "...", "name": "Launch", "session_ids": ["..."]}
   ]}`,
  schema: getProjectSchema,
  execute: async (args): Promise<GetProjectResult> => {
    const [
      { useChatSessionStore },
      { findProjectOrThrow },
      { loadAllSessionsForBerdctl },
    ] = await Promise.all([
      import("@/features/chat/stores/chatSessionStore"),
      import("../runtime/projects"),
      import("../runtime/sessions"),
    ]);
    const [project] = await Promise.all([
      findProjectOrThrow(args.project_id),
      loadAllSessionsForBerdctl(),
    ]);
    const sessions = useChatSessionStore.getState().sessions;
    const sessionCount = sessions.filter(
      (session) => session.projectId === project.id && !session.archivedAt,
    ).length;
    const sessionsById = new Map(
      sessions.map((session) => [session.id, session]),
    );
    const sessionsByClientId = new Map(
      sessions
        .filter((session) => session.clientSessionId)
        .map((session) => [session.clientSessionId as string, session]),
    );
    return {
      project_id: project.id,
      name: project.name,
      description: project.description,
      instructions: project.prompt,
      working_dirs: project.workingDirs,
      workspaces: project.projectWorkspaces.map((workspace) => ({
        path: workspace.path,
        startup_mode: workspace.startupMode,
      })),
      archived: project.archivedAt != null,
      session_count: sessionCount,
      chat_groups: (project.chatGroups?.groups ?? []).map((group) => ({
        group_id: group.id,
        name: group.name,
        session_ids: group.chatIds.flatMap((sessionId) => {
          const session =
            sessionsById.get(sessionId) ?? sessionsByClientId.get(sessionId);
          return session?.projectId === project.id && !session.archivedAt
            ? [session.id]
            : [];
        }),
      })),
    };
  },
});
