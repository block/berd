import type { SkillMentionItem } from "../ui/mentionDetection";

export interface AgentToolsCapabilityTip {
  id: string;
  label: string;
}

interface AgentToolsCapability {
  id: string;
  label: string;
  aliases: string[];
}

const AGENT_TOOLS_SKILL_NAMES = new Set(["sq-agent-tools", "sq agent-tools"]);

const AGENT_TOOLS_CAPABILITIES: AgentToolsCapability[] = [
  { id: "slack", label: "Slack", aliases: ["slack"] },
  { id: "linear", label: "Linear", aliases: ["linear"] },
  {
    id: "google-drive",
    label: "Google Drive",
    aliases: ["google drive", "google-drive", "gdrive", "google docs"],
  },
  {
    id: "google-calendar",
    label: "Google Calendar",
    aliases: ["google calendar", "google-calendar"],
  },
  { id: "gmail", label: "Gmail", aliases: ["gmail", "email"] },
  { id: "jira", label: "Jira", aliases: ["jira"] },
  { id: "sourcegraph", label: "Sourcegraph", aliases: ["sourcegraph"] },
  { id: "datadog", label: "Datadog", aliases: ["datadog"] },
  {
    id: "launchdarkly",
    label: "LaunchDarkly",
    aliases: ["launchdarkly", "launch darkly"],
  },
  { id: "pagerduty", label: "PagerDuty", aliases: ["pagerduty", "pager duty"] },
  { id: "workday", label: "Workday", aliases: ["workday"] },
  { id: "notion", label: "Notion", aliases: ["notion"] },
  { id: "asana", label: "Asana", aliases: ["asana"] },
  { id: "airtable", label: "Airtable", aliases: ["airtable"] },
  { id: "bugsnag", label: "Bugsnag", aliases: ["bugsnag"] },
  { id: "sentry", label: "Sentry", aliases: ["sentry"] },
  {
    id: "salesforce",
    label: "Salesforce",
    aliases: ["salesforce", "salesforce sq", "salesforce-sq"],
  },
  { id: "greenhouse", label: "Greenhouse", aliases: ["greenhouse"] },
  { id: "todoist", label: "Todoist", aliases: ["todoist"] },
  { id: "contentful", label: "Contentful", aliases: ["contentful"] },
  { id: "looker", label: "Looker", aliases: ["looker", "looker-oncall"] },
  {
    id: "query-expert",
    label: "Query Expert",
    aliases: ["query expert", "query-expert", "snowflake"],
  },
  {
    id: "incidentio",
    label: "Incident.io",
    aliases: ["incidentio", "incident.io", "incident io"],
  },
];

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

export function resolveAgentToolsCapabilityTip(
  text: string,
  skills: SkillMentionItem[],
): AgentToolsCapabilityTip | null {
  if (!hasAgentToolsSkill(skills)) {
    return null;
  }

  const normalizedText = text.toLowerCase();
  for (const capability of AGENT_TOOLS_CAPABILITIES) {
    if (
      capability.aliases.some((alias) => containsAlias(normalizedText, alias))
    ) {
      return { id: capability.id, label: capability.label };
    }
  }

  return null;
}

const ALIAS_SUFFIX_PATTERN = "(?:s|ed|ing|er)?";

function containsAlias(text: string, alias: string): boolean {
  const normalizedAlias = escapeRegExp(alias.toLowerCase()).replace(
    /[-\s]+/g,
    "[-\\s]+",
  );
  return new RegExp(
    `(^|[^a-z0-9])${normalizedAlias}${ALIAS_SUFFIX_PATTERN}($|[^a-z0-9])`,
    "i",
  ).test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
