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

export type BuilderbotAutomation =
  | {
      kind: "scheduled";
      id: string;
      reference: string;
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
  return [
    ...stringArray(trigger.owners),
    ...(trigger.created_by ? [trigger.created_by] : []),
  ];
}

function routingRuleOwners(rule: BuilderbotRoutingRule): string[] {
  return [
    ...stringArray(rule.owners),
    ...(rule.owner ? [rule.owner] : []),
    ...(rule.created_by ? [rule.created_by] : []),
  ];
}

function scheduledTriggerToAutomation(
  trigger: BuilderbotScheduledTrigger,
): BuilderbotAutomation | null {
  const reference = trigger.reference?.trim();
  if (!reference) return null;
  return {
    kind: "scheduled",
    id: `scheduled:${reference}`,
    reference,
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
): BuilderbotAutomation | null {
  const reference = rule.reference?.trim();
  if (!reference) return null;
  return {
    kind: "routing",
    id: `routing:${reference}`,
    reference,
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
    .map(scheduledTriggerToAutomation)
    .filter((automation): automation is BuilderbotAutomation =>
      Boolean(automation),
    );
  const routingAutomations = (routing.rules ?? [])
    .filter((rule) => ownerMatches(currentUser, routingRuleOwners(rule)))
    .map(routingRuleToAutomation)
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
