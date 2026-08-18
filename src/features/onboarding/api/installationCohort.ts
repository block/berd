import { invoke } from "@tauri-apps/api/core";
import type { InstallationCohort } from "@/features/onboarding/model";

export const INSTALLATION_COHORT_TIMEOUT_MS = 5_000;

export function getInstallationCohort(): Promise<InstallationCohort> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error("Installation cohort lookup timed out")),
      INSTALLATION_COHORT_TIMEOUT_MS,
    );
    void invoke<InstallationCohort>("get_installation_cohort").then(
      (cohort) => {
        window.clearTimeout(timeout);
        resolve(cohort);
      },
      (error) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
