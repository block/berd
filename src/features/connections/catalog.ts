import type { ComponentType, SVGProps } from "react";
import {
  AirtableIcon,
  AsanaIcon,
  BlockDataIcon,
  BlockUidIcon,
  DatadogIcon,
  DoceboIcon,
  FigmaIcon,
  GitHubIcon,
  GleanIcon,
  GmailIcon,
  GoogleCalendarIcon,
  GoogleDriveIcon,
  GoogleTagManagerIcon,
  GreenhouseIcon,
  JiraIcon,
  LinearIcon,
  NotionIcon,
  OracleIcon,
  PagerDutyIcon,
  QueryExpertIcon,
  RiskIcon,
  SalesforceIcon,
  SentryIcon,
  SlackIcon,
  SquareIcon,
  TodoistIcon,
  WorkdayIcon,
} from "@/features/connections/ui/ServiceIcons";

export interface OAuthProviderEntry {
  provider: string;
  displayName: string;
  description: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  // Hidden from the Connections UI in this app. Used for providers that have
  // no `sq agent-tools` subcommand backing them (or, for `github`, where the
  // agent path goes through the `gh` CLI rather than this OAuth surface).
  // The entry stays in the catalog so this file remains a 1:1 mirror of G2.
  hidden?: boolean;
}

// Mirrors G2's OAUTH_PROVIDERS + oauthConfig.displayName + oauthDescriptions.
// Source of truth lives in g2's web/src/shared/constants/oauthProviders.ts and
// web/src/features/settings/utils/config.ts. Keep this list in sync when G2
// adds or renames a provider until kgoose exposes the catalog directly.
export const OAUTH_PROVIDERS: OAuthProviderEntry[] = [
  {
    provider: "block-uid",
    displayName: "Block User identity",
    description: "Access Block internal services",
    Icon: BlockUidIcon,
  },
  {
    provider: "slack",
    displayName: "Slack",
    description: "Access your Slack conversations and channels",
    Icon: SlackIcon,
  },
  {
    provider: "google-drive",
    displayName: "Google Drive",
    description: "Get access to the contents of your files",
    Icon: GoogleDriveIcon,
  },
  {
    provider: "linear",
    displayName: "Linear",
    description: "Get access to your Linear projects and issues",
    Icon: LinearIcon,
  },
  {
    provider: "github",
    displayName: "GitHub",
    description: "Access your GitHub repositories and issues",
    Icon: GitHubIcon,
    hidden: true,
  },
  {
    provider: "google-calendar",
    displayName: "Google Calendar",
    description: "Access and manage your calendar",
    Icon: GoogleCalendarIcon,
  },
  {
    provider: "block-data",
    displayName: "Block Data",
    description: "Get access to Block Data",
    Icon: BlockDataIcon,
  },
  {
    provider: "gmail",
    displayName: "Gmail",
    description: "Access and manage your Gmail messages",
    Icon: GmailIcon,
  },
  {
    provider: "square-api",
    displayName: "Square API",
    description: "Access your Square data and transactions",
    Icon: SquareIcon,
    hidden: true,
  },
  {
    provider: "glean",
    displayName: "Glean",
    description: "Get access to Glean search",
    Icon: GleanIcon,
  },
  {
    provider: "airtable",
    displayName: "Airtable",
    description: "Interact with Airtable bases and tables",
    Icon: AirtableIcon,
  },
  {
    provider: "asana",
    displayName: "Asana",
    description: "Access your Asana projects and tasks",
    Icon: AsanaIcon,
  },
  {
    provider: "greenhouse",
    displayName: "Greenhouse",
    description: "Interact with Greenhouse applications and candidates",
    Icon: GreenhouseIcon,
    hidden: true,
  },
  {
    provider: "jira",
    displayName: "JIRA",
    description: "Access your JIRA projects and issues",
    Icon: JiraIcon,
  },
  {
    provider: "notion",
    displayName: "Notion",
    description: "Access and manage your Notion pages and databases",
    Icon: NotionIcon,
  },
  {
    provider: "todoist",
    displayName: "Todoist",
    description: "Manage your Todoist tasks and projects",
    Icon: TodoistIcon,
  },
  {
    provider: "docebo",
    displayName: "Block Academy",
    description:
      "Search and use your Block Academy courses and learning content",
    Icon: DoceboIcon,
  },
  {
    provider: "query-expert",
    displayName: "Query Expert",
    description: "Get access to expert query insights to generate SQL",
    Icon: QueryExpertIcon,
  },
  {
    provider: "risk",
    displayName: "Risk",
    description: "Access Risk data and insights",
    Icon: RiskIcon,
  },
  {
    provider: "workday",
    displayName: "Workday",
    description: "Access your Workday data and reports",
    Icon: WorkdayIcon,
  },
  {
    provider: "datadog",
    displayName: "Datadog",
    description: "Access your Datadog dashboards, metrics, and logs",
    Icon: DatadogIcon,
  },
  {
    provider: "figma",
    displayName: "Figma",
    description: "Access your Figma files and design resources",
    Icon: FigmaIcon,
  },
  {
    provider: "pagerduty",
    displayName: "PagerDuty",
    description: "Access your PagerDuty incidents, schedules, and on-call data",
    Icon: PagerDutyIcon,
  },
  {
    provider: "sentry",
    displayName: "Sentry",
    description: "Access Sentry issues and projects",
    Icon: SentryIcon,
  },
  {
    provider: "oracle-scm",
    displayName: "Oracle-SCM",
    description: "Get access to Oracle Supply Chain Management data",
    Icon: OracleIcon,
  },
  {
    provider: "oracle-finance",
    displayName: "Oracle-Finance",
    description: "Get access to Oracle Finance data",
    Icon: OracleIcon,
    hidden: true,
  },
  {
    provider: "google-tag-manager",
    displayName: "Google Tag Manager",
    description: "Access and manage your resources in Google Tag Manager",
    Icon: GoogleTagManagerIcon,
    hidden: true,
  },
  {
    provider: "sales",
    displayName: "Sales",
    description: "Access Salesforce data",
    Icon: SalesforceIcon,
  },
  {
    provider: "cf1",
    displayName: "CF1",
    description: "Access CF1 Salesforce data",
    Icon: SalesforceIcon,
  },
  {
    provider: "salesforce-sq",
    displayName: "Salesforce (Square)",
    description: "Access Square Salesforce data with schema discovery",
    Icon: SalesforceIcon,
  },
];
