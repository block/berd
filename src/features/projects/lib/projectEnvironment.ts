import { parseProjectEnvironment, type ProjectInfo } from "../api/projects";
import { getExperiment } from "@/features/experiments/experimentPreferences";
import { REMOTE_SSH_SESSIONS_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";

/** Resolve defaults only at creation, without changing existing sessions. */
export function projectEnvironment(project?: ProjectInfo) {
  return getExperiment(REMOTE_SSH_SESSIONS_EXPERIMENT_ID)?.enabled
    ? parseProjectEnvironment(project?.environment)
    : null;
}
