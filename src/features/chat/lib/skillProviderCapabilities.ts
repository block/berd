import { isGooseManagedProvider } from "@/shared/api/acpPersonaHandoff";

export type SkillDiscoveryMode = "goose-sources" | "agent-skill-files";
export type SkillActivationStyle =
  | "goose"
  | "codex"
  | "claude"
  | "gemini"
  | "standard";

export interface SkillProviderCapabilities {
  supportsSkillDiscovery: boolean;
  supportsSkillMentions: boolean;
  discoveryMode: SkillDiscoveryMode;
  activationStyle: SkillActivationStyle;
}

export function getSkillProviderCapabilities(
  providerId: string | null | undefined,
): SkillProviderCapabilities {
  const gooseManaged = !providerId || isGooseManagedProvider(providerId);
  const normalizedProviderId = providerId?.toLowerCase() ?? "";
  const activationStyle = normalizedProviderId.includes("codex")
    ? "codex"
    : normalizedProviderId.includes("claude")
      ? "claude"
      : normalizedProviderId.includes("gemini")
        ? "gemini"
        : gooseManaged
          ? "goose"
          : "standard";

  return {
    supportsSkillDiscovery: true,
    supportsSkillMentions: true,
    discoveryMode: gooseManaged ? "goose-sources" : "agent-skill-files",
    activationStyle,
  };
}
