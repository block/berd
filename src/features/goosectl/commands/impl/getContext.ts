import { z } from "zod/v4";

import { defineCommand } from "../types";

const getContextSchema = z.object({}).strict();

interface GetContextResult {
  view: string;
  active_session_id: string | null;
  active_project_id: string | null;
  app_version: string;
}

export const getContextCommand = defineCommand({
  effect: "read",
  visibility: "none",
  destructive: false,
  summary: "Read what the user is looking at in the app right now",
  description:
    "Read the app's current context: which view and session the user is " +
    "looking at, the active session's project, and the app version; does " +
    "not change anything on screen.",
  helpFooter: `Example:
  goosectl info context --json

Result:
  {"view": "...", "active_session_id": "..."|null,
   "active_project_id": "..."|null, "app_version": "..."}`,
  schema: getContextSchema,
  execute: async (): Promise<GetContextResult> => {
    const [{ default: packageJson }, { getAppNavigationController }] =
      await Promise.all([
        import("../../../../../package.json"),
        import("../../navigation"),
      ]);
    const context = getAppNavigationController().getAppContext();
    return {
      view: context.view,
      active_session_id: context.activeSessionId,
      active_project_id: context.activeProjectId,
      // Match telemetry's resolution: prefer the build-injected version
      // (git-derived for non-release builds), fall back to package.json.
      app_version: import.meta.env.VITE_APP_VERSION ?? packageJson.version,
    };
  },
});
