import { invoke } from "@tauri-apps/api/core";
import type { InstallationCohort } from "@/features/onboarding/model";

export function getInstallationCohort(): Promise<InstallationCohort> {
  return invoke<InstallationCohort>("get_installation_cohort");
}
