import { OAUTH_PROVIDERS } from "@/features/connections/catalog";
import { escapeRegExp } from "@/shared/lib/escapeRegExp";
import type { SkillMentionItem } from "../ui/mentionDetection";

export interface AgentToolsCapabilityTip {
  id: string;
  label: string;
  provider: string;
}

interface AgentToolsCapability {
  id: string;
  label: string;
  provider: string;
  aliases: string[];
}

const AGENT_TOOLS_SKILL_NAMES = new Set(["sq-agent-tools", "sq agent-tools"]);

const AGENT_TOOLS_PROVIDER_ALIASES: Record<string, string[]> = {
  "block-data": ["block data", "block-data"],
  "block-uid": ["block uid", "block user identity", "block identity"],
  "google-calendar": ["google calendar", "google-calendar", "gcal", "calendar"],
  "google-drive": [
    "google drive",
    "google-drive",
    "gdrive",
    "google docs",
    "google sheets",
    "google slides",
    "docs",
    "sheets",
    "slides",
  ],
  gmail: ["gmail", "email"],
  jira: ["jira"],
  pagerduty: ["pagerduty", "pager duty"],
  "query-expert": ["query expert", "query-expert", "snowflake"],
  sales: ["sales", "salesforce"],
  "salesforce-sq": ["salesforce square", "salesforce sq", "salesforce-sq"],
};

const AGENT_TOOLS_CAPABILITIES: AgentToolsCapability[] = OAUTH_PROVIDERS.filter(
  (provider) => provider.hidden !== true,
).map((entry) => ({
  id: entry.provider,
  label: entry.displayName,
  provider: entry.provider,
  aliases: uniqueAliases([
    entry.provider,
    entry.displayName,
    ...(AGENT_TOOLS_PROVIDER_ALIASES[entry.provider] ?? []),
  ]),
}));

function uniqueAliases(aliases: string[]): string[] {
  return Array.from(
    new Set(
      aliases
        .map((alias) => alias.trim().toLowerCase())
        .filter((alias) => alias.length > 0),
    ),
  );
}

export function hasAgentToolsSkill(skills: SkillMentionItem[]): boolean {
  return skills.some((skill) => {
    const name = skill.name.trim().toLowerCase();
    return (
      AGENT_TOOLS_SKILL_NAMES.has(name) ||
      skill.description.toLowerCase().includes("sq agent-tools") ||
      skill.description.toLowerCase().includes("sq agent tools")
    );
  });
}

export function resolveAgentToolsCapabilityTips(
  text: string,
  skills: SkillMentionItem[],
): AgentToolsCapabilityTip[] {
  if (!hasAgentToolsSkill(skills)) {
    return [];
  }

  const normalizedText = text.toLowerCase();
  const matchesByCapability = new Map<
    string,
    {
      capability: AgentToolsCapability;
      index: number;
      length: number;
    }
  >();

  for (const capability of AGENT_TOOLS_CAPABILITIES) {
    for (const alias of capability.aliases) {
      const match = findAliasMatch(normalizedText, alias);
      const existingMatch = matchesByCapability.get(capability.id);
      if (
        match &&
        (!existingMatch ||
          match.index > existingMatch.index ||
          (match.index === existingMatch.index &&
            match.length > existingMatch.length))
      ) {
        matchesByCapability.set(capability.id, { capability, ...match });
      }
    }
  }

  return Array.from(matchesByCapability.values())
    .sort((a, b) => a.index - b.index || a.length - b.length)
    .map(({ capability }) => ({
      id: capability.id,
      label: capability.label,
      provider: capability.provider,
    }));
}

export function resolveAgentToolsCapabilityTip(
  text: string,
  skills: SkillMentionItem[],
): AgentToolsCapabilityTip | null {
  return resolveAgentToolsCapabilityTips(text, skills).at(-1) ?? null;
}

const ALIAS_SUFFIX_PATTERN = "(?:s|ed|ing|er)?";

function findAliasMatch(
  text: string,
  alias: string,
): { index: number; length: number } | null {
  const normalizedAlias = escapeRegExp(alias.toLowerCase()).replace(
    /[-\s]+/g,
    "[-\\s]+",
  );
  const pattern = new RegExp(
    `(^|[^a-z0-9])(${normalizedAlias}${ALIAS_SUFFIX_PATTERN})($|[^a-z0-9])`,
    "gi",
  );

  let bestMatch: { index: number; length: number } | null = null;
  for (const match of text.matchAll(pattern)) {
    const prefix = match[1] ?? "";
    const matchedAlias = match[2] ?? "";
    bestMatch = {
      index: match.index + prefix.length,
      length: matchedAlias.length,
    };
  }

  return bestMatch;
}
