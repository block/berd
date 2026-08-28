import { invoke } from "@tauri-apps/api/core";

export async function claimSessionFeedbackSurveyCooldown({
  samplingRateBasisPoints,
  random,
  cooldownRandom,
}: {
  samplingRateBasisPoints: number;
  random: number;
  cooldownRandom: number;
}): Promise<boolean> {
  return invoke<boolean>("claim_session_feedback_survey_cooldown", {
    input: { samplingRateBasisPoints, random, cooldownRandom },
  });
}
