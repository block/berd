export { KEEP_ENABLED } from "@/features/extensions/lib/keepEnabled";

/**
 * Provider the migration pre-selects. Every user on this build is a Square
 * employee with Databricks pre-provisioned. We target the AI Gateway v2
 * provider (`databricks_v2`); the legacy `databricks` provider is left
 * available for any users who still need it.
 */
export const DEFAULT_PROVIDER_ID = "databricks_v2";

/**
 * Default Databricks model id the migration pre-selects after import. Leave
 * `undefined` to skip pre-selecting a model so the user picks one from the
 * chat model picker on first run.
 */
export const DEFAULT_MODEL_ID: string | undefined = "goose-gpt-5-5";

/**
 * Display name mirrored into the per-agent model preference so the chat UI
 * shows a friendly label instead of the raw model id. Unused when
 * `DEFAULT_MODEL_ID` is `undefined`.
 */
export const DEFAULT_MODEL_NAME = "GPT-5.5";
