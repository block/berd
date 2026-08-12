import { z } from "zod/v4";

import { CommandError, defineCommand } from "../types";

const moveSessionToGroupSchema = z
  .object({
    session_id: z.string().describe("Id of the session to move."),
    group_id: z
      .string()
      .describe(
        "Id of the destination chat group, from `berdctl project get`.",
      ),
  })
  .strict();

interface MoveSessionToGroupResult {
  ok: true;
  project_id: string;
  group_id: string;
  group_name: string;
}

const projectGroupMoveTails = new Map<string, Promise<void>>();

async function serializeProjectGroupMove<T>(
  projectId: string,
  move: () => Promise<T>,
): Promise<T> {
  const previous = projectGroupMoveTails.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  projectGroupMoveTails.set(projectId, tail);

  await previous.catch(() => undefined);
  try {
    return await move();
  } finally {
    release();
    if (projectGroupMoveTails.get(projectId) === tail) {
      projectGroupMoveTails.delete(projectId);
    }
  }
}

export const moveSessionToGroupCommand = defineCommand({
  effect: "update",
  visibility: "immediate",
  destructive: false,
  summary: "Move a chat session into an existing project group",
  description:
    "Move a chat session into an existing group in its current project; the project chat list regroups immediately.",
  helpFooter: `Find the destination group id with:
  berdctl project get --project-id <project-id> --json

Example:
  berdctl session move-to-group --session-id <session-id> \\
    --group-id <group-id>

Result:
  {"ok": true, "project_id": "...", "group_id": "...",
   "group_name": "..."} — the project chat list regroups immediately.`,
  schema: moveSessionToGroupSchema,
  execute: async (args, ctx): Promise<MoveSessionToGroupResult> => {
    const [
      { updateProject },
      { useProjectStore },
      { refusePastDeadline },
      { findProjectOrThrow },
      { loadSessionForBerdctl, requireSession },
    ] = await Promise.all([
      import("@/features/projects/api/projects"),
      import("@/features/projects/stores/projectStore"),
      import("../runtime/deadline"),
      import("../runtime/projects"),
      import("../runtime/sessions"),
    ]);

    await loadSessionForBerdctl(args.session_id);
    const session = requireSession(args.session_id);
    if (!session.projectId) {
      throw new CommandError(
        "invalid_args",
        `Session "${args.session_id}" is not in a project; move it into a project with \`berdctl session move\` first.`,
      );
    }

    const projectId = session.projectId;
    return serializeProjectGroupMove(projectId, async () => {
      // Re-read inside the per-project queue so overlapping commands always
      // base their replacement metadata on the previous completed move.
      const project = await findProjectOrThrow(projectId);
      const groups = project.chatGroups?.groups ?? [];
      const destination = groups.find((group) => group.id === args.group_id);
      if (!destination) {
        throw new CommandError(
          "invalid_args",
          `No chat group "${args.group_id}" in project "${project.id}"; list its groups with \`berdctl project get --project-id ${project.id}\`.`,
        );
      }

      refusePastDeadline(ctx, "the session was not moved into the group");

      const sessionIds = new Set(
        [session.id, session.clientSessionId].filter(
          (id): id is string => typeof id === "string",
        ),
      );
      const nextGroups = groups
        .map((group) => ({
          ...group,
          chatIds: [
            ...group.chatIds.filter((chatId) => !sessionIds.has(chatId)),
            ...(group.id === destination.id ? [session.id] : []),
          ],
        }))
        .filter(
          (group, index) =>
            group.chatIds.length > 0 || groups[index]?.chatIds.length === 0,
        );

      const savedProject = await updateProject(project, {
        chatGroups: { groups: nextGroups },
      });
      useProjectStore
        .getState()
        .replaceProjectsFromBackend(
          useProjectStore
            .getState()
            .projects.map((candidate) =>
              candidate.id === savedProject.id ? savedProject : candidate,
            ),
        );

      return {
        ok: true,
        project_id: project.id,
        group_id: destination.id,
        group_name: destination.name,
      };
    });
  },
});
