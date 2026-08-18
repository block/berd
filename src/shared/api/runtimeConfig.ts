import {
  type RuntimeConfig,
  type RuntimeConfigLoadResult,
  runtimeConfigLoadResultSchema,
  runtimeConfigSchema,
} from "@/shared/runtime-config/schema";
import { invokeWithStartupRetry } from "./invokeWithStartupRetry";

function parseRuntimeConfigLoadResult(value: unknown): RuntimeConfigLoadResult {
  return runtimeConfigLoadResultSchema.parse(value);
}

export async function getRuntimeConfig(): Promise<RuntimeConfigLoadResult> {
  return parseRuntimeConfigLoadResult(
    await invokeWithStartupRetry("get_runtime_config"),
  );
}

export async function refreshRuntimeConfig(): Promise<RuntimeConfigLoadResult> {
  return parseRuntimeConfigLoadResult(
    await invokeWithStartupRetry("refresh_runtime_config"),
  );
}

export async function setFakeRuntimeConfig(
  config: RuntimeConfig,
): Promise<RuntimeConfigLoadResult> {
  const validated = runtimeConfigSchema.parse(config);
  return parseRuntimeConfigLoadResult(
    await invokeWithStartupRetry("set_fake_runtime_config", {
      config: validated,
    }),
  );
}

export async function clearFakeRuntimeConfig(): Promise<RuntimeConfigLoadResult> {
  return parseRuntimeConfigLoadResult(
    await invokeWithStartupRetry("clear_fake_runtime_config"),
  );
}
