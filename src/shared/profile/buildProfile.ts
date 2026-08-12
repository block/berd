export type BuildFeature =
  | "authGate"
  | "agentTools"
  | "automations"
  | "builderbot"
  | "byoKeyProviders"
  | "feedback"
  | "managedConnections"
  | "telemetry"
  | "voiceConversation"
  | "voiceDictation"
  | "securityMl"
  | "updater";

/**
 * Product families backed by Block-only services are positive opt-ins. A
 * normal public build has no value for these variables and therefore cannot
 * expose a path that depends on KGoose, G2, or Builderbot. Distributions may
 * restore each family independently by setting exactly its variable to `1`.
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
    managedConnections: import.meta.env.VITE_MANAGED_CONNECTIONS === "1",
    telemetry: import.meta.env.VITE_TELEMETRY !== "0",
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
