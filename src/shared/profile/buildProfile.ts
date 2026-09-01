export type BuildFeature =
  | "authGate"
  | "agentTools"
  | "automations"
  | "builderbot"
  | "byoKeyProviders"
  | "feedback"
  | "feedbackSurveys"
  | "managedConnections"
  | "skillDiscovery"
  | "telemetry"
  | "telemetryEnforced"
  | "voiceConversation"
  | "voiceDictation"
  | "securityMl"
  | "updater";

/**
 * Product families backed by Block-only services are positive opt-ins. A
 * normal public build has no value for these variables and therefore cannot
 * expose a path that depends on KGoose, G2, or Builderbot. Human feedback
 * surveys use the same opt-in posture because their transport is supplied by
 * the distribution.
 */
function readBuildFeatures(): Record<BuildFeature, boolean> {
  return {
    authGate:
      import.meta.env.VITE_AUTH_GATE === "1" &&
      import.meta.env.VITE_BUILDERBOT === "1",
    agentTools: import.meta.env.VITE_AGENT_TOOLS === "1",
    automations: import.meta.env.VITE_AUTOMATIONS === "1",
    builderbot: import.meta.env.VITE_BUILDERBOT === "1",
    byoKeyProviders: import.meta.env.VITE_BYO_KEY_PROVIDERS !== "0",
    feedback: import.meta.env.VITE_FEEDBACK === "1",
    // Keep the existing broad opt-in working while allowing survey transports
    // that do not include KGoose issue feedback.
    feedbackSurveys:
      import.meta.env.VITE_FEEDBACK_SURVEYS === "1" ||
      import.meta.env.VITE_FEEDBACK === "1",
    managedConnections: import.meta.env.VITE_MANAGED_CONNECTIONS === "1",
    // Skill discovery shells out to the Block-internal sq-agents marketplace,
    // so it shares the Block-only positive opt-in posture: public builds must
    // never reach the internal catalog or its Zero Trust auth flow, even via
    // stale per-user experiment overrides.
    skillDiscovery: import.meta.env.VITE_SKILL_DISCOVERY === "1",
    telemetry: import.meta.env.VITE_TELEMETRY !== "0",
    // Managed internal distributions force telemetry consent ON: the user
    // setting is skipped and the settings toggle is hidden. A positive opt-in
    // like the Block-service gates; public builds leave it unset. Paired with
    // the `block-telemetry-enforced` Cargo feature (see
    // scripts/block-feature-gates.sh) so the native export gate agrees.
    telemetryEnforced: import.meta.env.VITE_TELEMETRY_ENFORCED === "1",
    // Native Voice Conversation is public functionality and deliberately does
    // not share dictation's KGoose-backed build gate.
    voiceConversation: true,
    voiceDictation: import.meta.env.VITE_VOICE_DICTATION === "1",
    securityMl: import.meta.env.VITE_SECURITY_ML === "1",
    updater: import.meta.env.VITE_UPDATER_ENABLED !== "false",
  };
}

export function getBuildFeatureState(): Record<BuildFeature, boolean> {
  return readBuildFeatures();
}
