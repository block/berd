import { z } from "zod/v4";
import { defineCommand } from "../types";

const listSessionFoldersSchema = z
  .object({
    session_id: z.string().min(1).describe("Id of the session to inspect."),
  })
  .strict();

export const listSessionFoldersCommand = defineCommand({
  effect: "read",
  visibility: "immediate",
  destructive: false,
  summary: "List folders attached to a chat and identify its cwd",
  description:
    "List every attached folder with its Git identity and whether it is the chat's current working directory.",
  helpFooter: `The top-level cwd is returned even when it is Berd's implicit default and is not an attached folder.

Example:
  berdctl folder list --session-id <session-id>

Result:
  {"ok": true, "cwd": "...", "folders": [{"path": "...", "kind": "...", "branch": "..."|null, "cwd": true|false}]}`,
  schema: listSessionFoldersSchema,
  execute: async (args) => {
    const [
      { getWorkspaceAttachments, isSameWorkspacePathWithHome },
      { getHomeDir },
      { useChatSessionStore },
      { loadSessionForBerdctl, requireSession },
    ] = await Promise.all([
      import("@/features/chat/lib/workspaceAttachments"),
      import("@/shared/api/system"),
      import("@/features/chat/stores/chatSessionStore"),
      import("../runtime/sessions"),
    ]);
    await loadSessionForBerdctl(args.session_id);
    const homeDir = await getHomeDir();
    const session = requireSession(args.session_id);
    const cwd = session.workingDir ?? null;
    const folders = getWorkspaceAttachments(
      useChatSessionStore.getState().getSession(args.session_id) ?? session,
    )
      .filter((attachment) => attachment.source !== "excluded")
      .map((attachment) => ({
        path: attachment.path,
        kind: attachment.kind,
        branch: attachment.branch ?? null,
        cwd:
          cwd != null &&
          isSameWorkspacePathWithHome(attachment.path, cwd, homeDir),
      }));
    return { ok: true as const, cwd, folders };
  },
});
