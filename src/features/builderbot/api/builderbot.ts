import { invoke } from "@tauri-apps/api/core";

export type BuilderbotTaskStatus =
  | "TASK_STATUS_PENDING"
  | "TASK_STATUS_READY"
  | "TASK_STATUS_IN_PROGRESS"
  | "TASK_STATUS_BLOCKED"
  | "TASK_STATUS_COMPLETED"
  | "TASK_STATUS_FAILED"
  | "TASK_STATUS_CANCELLED"
  | string;

export interface BuilderbotTask {
  key?: string;
  description?: string;
  status?: BuilderbotTaskStatus;
  author?: string;
  assignee?: string | null;
  latest_actor?: string;
  created_at_ms?: number;
  updated_at_ms?: number;
  labels?: string[];
  artifacts?: unknown[];
  artifact_count?: number;
  artifacts_count?: number;
  artifacts_url?: string;
  artifacts_link?: string;
  thread_url?: string;
  thread_link?: string;
}

export interface BuilderbotRoutineConfig {
  routine_identifier?: string;
  input_payload?: string;
  run_as_service?: string;
  labels?: string[];
}

export interface BuilderbotScheduledTrigger {
  id?: number;
  reference?: string;
  enabled?: boolean;
  cron_expression?: string;
  next_run_at_sec?: number;
  last_run_at_sec?: number;
  last_status?: string;
  created_at_ms?: number;
  updated_at_ms?: number;
  created_by?: string;
  owners?: string[];
  routine?: BuilderbotRoutineConfig;
  task_config_json?: string;
}

export type UpdateBuilderbotScheduledTriggerRequest = Partial<
  Pick<
    BuilderbotScheduledTrigger,
    | "reference"
    | "enabled"
    | "cron_expression"
    | "routine"
    | "task_config_json"
    | "owners"
  >
>;

export interface BuilderbotRoutingCondition {
  path?: string;
  operator?: string;
  value?: string;
}

export interface BuilderbotRoutingRule {
  reference?: string;
  owner?: string;
  source?: string;
  enabled?: boolean;
  created_at_ms?: number;
  updated_at_ms?: number;
  created_by?: string;
  owners?: string[];
  task_status?: BuilderbotTaskStatus;
  description_template?: string;
  idempotency_key_template?: string;
  max_matches_per_idempotency?: number;
  idempotency_enabled?: boolean;
  outcome_labels?: string[];
  conditions?: BuilderbotRoutingCondition[];
  routine?: BuilderbotRoutineConfig;
}

export type UpdateBuilderbotRoutingRuleRequest = Partial<
  Pick<
    BuilderbotRoutingRule,
    | "reference"
    | "enabled"
    | "source"
    | "conditions"
    | "outcome_labels"
    | "task_status"
    | "description_template"
    | "idempotency_key_template"
    | "max_matches_per_idempotency"
    | "idempotency_enabled"
    | "routine"
    | "owners"
  >
>;

export interface BuilderbotTaskLinks {
  artifactCount?: number;
  artifactsUrl?: string;
  threadUrl?: string;
}

export type BuilderbotAutomation =
  | {
      kind: "scheduled";
      id: string;
      reference: string;
      displayName: string;
      enabled: boolean;
      createdBy?: string;
      updatedAtMs?: number;
      owners: string[];
      triggerLabel: string;
      routine?: BuilderbotRoutineConfig;
      lastStatus?: string;
      nextRunAtSec?: number;
      source: BuilderbotScheduledTrigger;
    }
  | {
      kind: "routing";
      id: string;
      reference: string;
      displayName: string;
      enabled: boolean;
      createdBy?: string;
      updatedAtMs?: number;
      owners: string[];
      triggerLabel: string;
      routine?: BuilderbotRoutineConfig;
      conditionCount: number;
      source: BuilderbotRoutingRule;
    };

interface BuilderbotTasksResponse {
  current_user?: string;
  tasks?: BuilderbotTask[];
}

interface BuilderbotScheduledTriggersResponse {
  current_user?: string;
  triggers?: BuilderbotScheduledTrigger[];
}

interface BuilderbotRoutingRulesResponse {
  current_user?: string;
  rules?: BuilderbotRoutingRule[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value.filter(isRecord) as T[]) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function nestedStringValue(
  value: unknown,
  keys: readonly string[],
): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const nested = stringValue(value[key]);
    if (nested) return nested;
  }
  return undefined;
}

export function getBuilderbotTaskLinks(
  task: BuilderbotTask,
): BuilderbotTaskLinks {
  const taskRecord = task as Record<string, unknown>;
  const artifactCount =
    numberValue(task.artifacts_count) ??
    numberValue(task.artifact_count) ??
    numberValue(taskRecord.artifactsCount) ??
    (Array.isArray(task.artifacts) ? task.artifacts.length : undefined) ??
    (Array.isArray(taskRecord.artifact_urls)
      ? taskRecord.artifact_urls.length
      : undefined) ??
    (Array.isArray(taskRecord.artifactUrls)
      ? taskRecord.artifactUrls.length
      : undefined);

  const artifactsUrl =
    stringValue(task.artifacts_url) ??
    stringValue(task.artifacts_link) ??
    stringValue(taskRecord.artifact_url) ??
    stringValue(taskRecord.artifactUrl) ??
    stringValue(taskRecord.artifactsUrl) ??
    nestedStringValue(taskRecord.artifacts, ["url", "href", "link"]);

  const threadUrl =
    stringValue(task.thread_url) ??
    stringValue(task.thread_link) ??
    stringValue(taskRecord.threadUrl) ??
    nestedStringValue(taskRecord.thread, ["url", "href", "link"]);

  return {
    artifactCount,
    artifactsUrl,
    threadUrl,
  };
}

export function summarizeBuilderbotCondition(
  condition: BuilderbotRoutingCondition,
): string | null {
  const parts = [condition.path, condition.operator, condition.value]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(" ") : null;
}

function asTasksResponse(value: unknown): BuilderbotTasksResponse {
  if (!isRecord(value)) return { tasks: [] };
  return {
    current_user:
      typeof value.current_user === "string" ? value.current_user : undefined,
    tasks: recordArray<BuilderbotTask>(value.tasks),
  };
}

function asScheduledTriggersResponse(
  value: unknown,
): BuilderbotScheduledTriggersResponse {
  if (!isRecord(value)) return { triggers: [] };
  return {
    current_user:
      typeof value.current_user === "string" ? value.current_user : undefined,
    triggers: recordArray<BuilderbotScheduledTrigger>(value.triggers),
  };
}

function asRoutingRulesResponse(
  value: unknown,
): BuilderbotRoutingRulesResponse {
  if (!isRecord(value)) return { rules: [] };
  return {
    current_user:
      typeof value.current_user === "string" ? value.current_user : undefined,
    rules: recordArray<BuilderbotRoutingRule>(value.rules),
  };
}

function ownerMatches(currentUser: string | undefined, owners: string[]) {
  if (!currentUser) return false;
  const normalizedUser = currentUser.toLowerCase();
  return owners.some((owner) => owner.toLowerCase() === normalizedUser);
}

function scheduledTriggerOwners(trigger: BuilderbotScheduledTrigger): string[] {
  return uniqueStrings([
    ...stringArray(trigger.owners),
    ...(trigger.created_by ? [trigger.created_by] : []),
  ]);
}

function routingRuleOwners(rule: BuilderbotRoutingRule): string[] {
  return uniqueStrings([
    ...stringArray(rule.owners),
    ...(rule.owner ? [rule.owner] : []),
    ...(rule.created_by ? [rule.created_by] : []),
  ]);
}

const DISPLAY_TOKEN_OVERRIDES: Record<string, string> = {
  ai: "AI",
  api: "API",
  bb: "BB",
  builderbot: "BuilderBot",
  ci: "CI",
  github: "GitHub",
  goose: "Goose",
  jira: "Jira",
  pr: "PR",
  sa: "SA",
  sentry: "Sentry",
  slack: "Slack",
  tg: "TG",
  ui: "UI",
  url: "URL",
};

function stripCurrentUserPrefix(
  reference: string,
  currentUser: string | undefined,
) {
  const user = currentUser?.trim().toLowerCase();
  if (!user) return reference;
  const normalized = reference.toLowerCase();
  if (normalized.startsWith(`${user}-`) || normalized.startsWith(`${user}_`)) {
    return reference.slice(user.length + 1);
  }
  return reference;
}

function displayToken(token: string, index: number) {
  const normalized = token.toLowerCase();
  const override = DISPLAY_TOKEN_OVERRIDES[normalized];
  if (override) return override;
  if (index === 0 && normalized) {
    return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
  }
  return normalized;
}

export function builderbotReferenceDisplayName(
  reference: string,
  currentUser?: string,
) {
  const stripped = stripCurrentUserPrefix(reference.trim(), currentUser);
  const tokens = stripped
    .split(/[-_\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (!tokens.length) return reference.trim();
  return tokens.map(displayToken).join(" ");
}

function scheduledTriggerToAutomation(
  trigger: BuilderbotScheduledTrigger,
  currentUser: string | undefined,
): BuilderbotAutomation | null {
  const reference = trigger.reference?.trim();
  if (!reference) return null;
  return {
    kind: "scheduled",
    id: `scheduled:${reference}`,
    reference,
    displayName: builderbotReferenceDisplayName(reference, currentUser),
    enabled: trigger.enabled ?? false,
    createdBy: trigger.created_by,
    updatedAtMs: trigger.updated_at_ms ?? trigger.created_at_ms,
    owners: scheduledTriggerOwners(trigger),
    triggerLabel: trigger.cron_expression ?? "",
    routine: trigger.routine,
    lastStatus: trigger.last_status,
    nextRunAtSec: trigger.next_run_at_sec,
    source: trigger,
  };
}

function routingRuleToAutomation(
  rule: BuilderbotRoutingRule,
  currentUser: string | undefined,
): BuilderbotAutomation | null {
  const reference = rule.reference?.trim();
  if (!reference) return null;
  return {
    kind: "routing",
    id: `routing:${reference}`,
    reference,
    displayName: builderbotReferenceDisplayName(reference, currentUser),
    enabled: rule.enabled ?? false,
    createdBy: rule.created_by ?? rule.owner,
    updatedAtMs: rule.updated_at_ms ?? rule.created_at_ms,
    owners: routingRuleOwners(rule),
    triggerLabel: rule.source ?? "",
    routine: rule.routine,
    conditionCount: Array.isArray(rule.conditions) ? rule.conditions.length : 0,
    source: rule,
  };
}

export async function getBuilderbotTasks(limit = 50) {
  const response = await invoke<unknown>("get_builderbot_tasks", { limit });
  const parsed = asTasksResponse(response);
  return {
    currentUser: parsed.current_user,
    tasks: parsed.tasks ?? [],
  };
}

export async function getBuilderbotAutomations(limit = 50) {
  const [scheduledResponse, routingResponse] = await Promise.all([
    invoke<unknown>("get_builderbot_scheduled_triggers", { limit }),
    invoke<unknown>("get_builderbot_routing_rules", { limit }),
  ]);
  const scheduled = asScheduledTriggersResponse(scheduledResponse);
  const routing = asRoutingRulesResponse(routingResponse);
  const currentUser = scheduled.current_user ?? routing.current_user;
  const scheduledAutomations = (scheduled.triggers ?? [])
    .filter((trigger) =>
      ownerMatches(currentUser, scheduledTriggerOwners(trigger)),
    )
    .map((trigger) => scheduledTriggerToAutomation(trigger, currentUser))
    .filter((automation): automation is BuilderbotAutomation =>
      Boolean(automation),
    );
  const routingAutomations = (routing.rules ?? [])
    .filter((rule) => ownerMatches(currentUser, routingRuleOwners(rule)))
    .map((rule) => routingRuleToAutomation(rule, currentUser))
    .filter((automation): automation is BuilderbotAutomation =>
      Boolean(automation),
    );

  return {
    currentUser,
    automations: [...scheduledAutomations, ...routingAutomations].sort(
      (a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0),
    ),
  };
}

export async function updateBuilderbotScheduledTrigger(
  reference: string,
  request: UpdateBuilderbotScheduledTriggerRequest,
) {
  return invoke<unknown>("update_builderbot_scheduled_trigger", {
    reference,
    request,
  });
}

export async function updateBuilderbotRoutingRule(
  reference: string,
  request: UpdateBuilderbotRoutingRuleRequest,
) {
  return invoke<unknown>("update_builderbot_routing_rule", {
    reference,
    request,
  });
}
