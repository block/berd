import { checkAllProviderStatus } from "./api/credentials";
import { readGooseDefaults } from "./api/gooseDefaults";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import type { ShareInFlightOptions } from "@/shared/lib/shareInFlight";
import { normalizeConcreteModelId } from "@/shared/lib/modelIdentity";

export type DefaultProviderReadiness =
  | {
      status: "ready";
      providerId: string;
      modelId?: string;
    }
  | {
      status: "needs_setup";
      reason:
        | "missing_defaults"
        | "provider_unconfigured"
        | "model_missing"
        | "provider_not_available";
      providerId?: string;
      modelId?: string;
    }
  | {
      status: "unknown";
      error: string;
    };

function normalizeDefault(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * `options` reaches both shared reads below, so a startup caller can opt both
 * into coalescing with one flag. Plain calls fetch, which is what a readiness
 * check after a config write needs.
 */
export async function readDefaultProviderReadiness(
  options?: ShareInFlightOptions,
): Promise<DefaultProviderReadiness> {
  try {
    const defaults = await readGooseDefaults(options);
    const providerId = normalizeDefault(defaults.providerId);
    const modelId = normalizeConcreteModelId(
      normalizeDefault(defaults.modelId),
    );

    if (!providerId) {
      return { status: "needs_setup", reason: "missing_defaults" };
    }

    if (!modelId) {
      return { status: "needs_setup", reason: "model_missing", providerId };
    }

    const statuses = await checkAllProviderStatus(options);
    const providerStatus = statuses.find(
      (status) => status.providerId === providerId,
    );

    if (!providerStatus) {
      return {
        status: "needs_setup",
        reason: "provider_not_available",
        providerId,
        modelId,
      };
    }

    if (!providerStatus.isConfigured) {
      return {
        status: "needs_setup",
        reason: "provider_unconfigured",
        providerId,
        modelId,
      };
    }

    return { status: "ready", providerId, modelId };
  } catch (error) {
    return { status: "unknown", error: formatAcpErrorMessage(error) };
  }
}
