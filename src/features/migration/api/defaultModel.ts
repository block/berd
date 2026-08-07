import { readGooseDefaults } from "@/features/providers/api/gooseDefaults";
import { normalizeConcreteModelId } from "@/shared/lib/modelIdentity";

export interface DefaultModelStatus {
  providerId?: string;
  modelId?: string;
  /**
   * True when a provider is configured but its model id is empty or missing.
   * Every `setProvider` against this state fails with `-32603`
   * ("Configuration value not found: GOOSE_MODEL"), locking the chat UI;
   * the recovery gate short-circuits on this signal before `setProvider`.
   */
  modelMissing: boolean;
}

function normalize(value: string | null | undefined): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Pre-flight read of the backend's persisted Goose defaults via
 * `_goose/defaults/read`. Returns the active provider/model ids and a
 * deterministic `modelMissing` flag for the broken state Phase 2 recovers
 * from, so callers can route to the recovery screen without parsing a
 * `-32603` error string raised later by `acpPrepareSession`.
 */
export async function readDefaultModelStatus(): Promise<DefaultModelStatus> {
  // Reads plainly (no `coalesce`): this decides whether to *write* repaired
  // defaults, and `useDefaultModelGate` runs only once startup readiness and
  // the migration gate have settled, so there is no startup read left to join.
  const defaults = await readGooseDefaults();
  const providerId = normalize(defaults.providerId);
  const modelId = normalizeConcreteModelId(normalize(defaults.modelId));
  return {
    providerId,
    modelId,
    modelMissing: providerId !== undefined && modelId === undefined,
  };
}
