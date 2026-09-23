import { z } from "zod/v4";

import { defineCommand } from "../types";

const getContextSchema = z.object({}).strict();

interface GetContextResult {
  view: string;
  active_session_id: string | null;
  active_project_id: string | null;
  /** Current display name of the active project, or null. */
  active_project_name: string | null;
  voice_session_active: boolean;
  app_version: string;
}

function rendererVoiceSessionActive(
  voice: {
    status: { sessionId: string | null; revision: number };
    uiState: string;
  },
  nativeRevision: number,
): boolean {
  return (
    voice.status.revision >= nativeRevision &&
    (voice.status.sessionId !== null ||
      voice.uiState === "starting" ||
      voice.uiState === "stopping")
  );
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
  berdctl info context --json

Result:
  {"view": "...", "active_session_id": "..."|null,
   "active_project_id": "..."|null, "active_project_name": "..."|null,
   "voice_session_active": true|false, "app_version": "..."}

"active_project_id" is a stable identifier that does not change when the
project is renamed; "active_project_name" is the project's current display
name and may not match the id (e.g. "goose-internal" / "Berd").`,
  schema: getContextSchema,
  execute: async (): Promise<GetContextResult> => {
    const [
      { default: packageJson },
      { getAppNavigationController },
      { getVoiceConversationStatus },
      { useVoiceConversationStore },
      { findCurrentProjectForBerdctl },
    ] = await Promise.all([
      import("../../../../../package.json"),
      import("../../navigation"),
      import("@/features/voice-conversation/api/voiceConversation"),
      import("@/features/voice-conversation/stores/voiceConversationStore"),
      import("../runtime/projects"),
    ]);
    const context = getAppNavigationController().getAppContext();
    // Capture the ID before refreshing projects so the ID and name describe the
    // same project even if app navigation changes while the backend request runs.
    const activeProjectId = context.activeProjectId;
    const voiceBeforeRefresh = useVoiceConversationStore.getState();
    const [nativeVoiceStatus, activeProject] = await Promise.all([
      getVoiceConversationStatus(),
      activeProjectId
        ? findCurrentProjectForBerdctl(activeProjectId)
        : Promise.resolve(null),
    ]);
    const voiceAfterRefresh = useVoiceConversationStore.getState();
    const activeProjectName = activeProject?.name ?? null;
    return {
      view: context.view,
      active_session_id: context.activeSessionId,
      active_project_id: activeProjectId,
      active_project_name: activeProjectName,
      voice_session_active:
        nativeVoiceStatus.sessionId !== null ||
        rendererVoiceSessionActive(
          voiceBeforeRefresh,
          nativeVoiceStatus.revision,
        ) ||
        rendererVoiceSessionActive(
          voiceAfterRefresh,
          nativeVoiceStatus.revision,
        ),
      // Match telemetry's resolution: prefer the build-injected version
      // (git-derived for non-release builds), fall back to package.json.
      app_version: import.meta.env.VITE_APP_VERSION ?? packageJson.version,
    };
  },
});
