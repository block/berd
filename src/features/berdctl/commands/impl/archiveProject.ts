import { z } from "zod/v4";

import { berdctlErrorDetail, backendArchiveFailedMessage } from "../helpers";
import { CommandError, defineCommand } from "../types";

const archiveProjectSchema = z
  .object({
    project_id: z.string().describe("Id of the project to archive."),
  })
  .strict();

export const archiveProjectCommand = defineCommand({
  effect: "archive",
  visibility: "immediate",
  destructive: false,
  summary: "Archive a project (reversible; nothing is deleted)",
  description:
    "Archive a project; it disappears from the app's project list " +
    "(reversible from the archive). Sessions in the project are not " +
    "archived and keep their project assignment.",
  helpFooter: `Archiving is reversible from the app's archive view; nothing is
deleted, and the project's sessions are left untouched.

Example:
  berdctl project archive --project-id <project-id>

Result:
  {"ok": true} — the project disappears from the app's project list.`,
  schema: archiveProjectSchema,
  execute: async (args) => {
    const [{ archiveProject }, { findProjectOrThrow, loadProjectsForBerdctl }] =
      await Promise.all([
        import("@/features/projects/api/projects"),
        import("../runtime/projects"),
      ]);
    await findProjectOrThrow(args.project_id);
    try {
      await archiveProject(args.project_id);
    } catch (error) {
      throw new CommandError(
        "backend_archive_failed",
        backendArchiveFailedMessage(
          "project",
          args.project_id,
          berdctlErrorDetail(error),
        ),
      );
    }
    // Mirror AppShell's archive handler: refetch so the sidebar drops the
    // project immediately instead of waiting for the next natural refresh.
    await loadProjectsForBerdctl();
    return { ok: true as const };
  },
});
