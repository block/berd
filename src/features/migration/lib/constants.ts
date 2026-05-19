export { KEEP_ENABLED } from "@/features/extensions/lib/keepEnabled";

/**
 * Provider the migration pre-selects. Every user on this build is a Square
 * employee with Databricks pre-provisioned, so there is no fallback path — if
 * Databricks isn't reachable at first boot, surface the error and let the user
 * retry.
 */
export const DEFAULT_PROVIDER_ID = "databricks";

/**
 * Default Databricks model id the migration pre-selects after import. Leave
 * `undefined` to skip pre-selecting a model so the user picks one from the
 * chat model picker on first run.
 */
export const DEFAULT_MODEL_ID: string | undefined = "compass-openai-gpt-5-5";

/**
 * Display name mirrored into the per-agent model preference so the chat UI
 * shows a friendly label instead of the raw model id. Unused when
 * `DEFAULT_MODEL_ID` is `undefined`.
 */
export const DEFAULT_MODEL_NAME = "GPT-5.5";
