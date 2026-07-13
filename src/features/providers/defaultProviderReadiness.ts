import { checkAllProviderStatus } from "./api/credentials";
import { getClient } from "@/shared/api/acpConnection";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";

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

export async function readDefaultProviderReadiness(): Promise<DefaultProviderReadiness> {
  try {
    const client = await getClient();
    const defaults = await client.goose.GooseUnstableDefaultsRead({});
    const providerId = normalizeDefault(defaults.providerId);
    const modelId = normalizeDefault(defaults.modelId);

    if (!providerId) {
      return { status: "needs_setup", reason: "missing_defaults" };
    }

    if (!modelId) {
      return { status: "needs_setup", reason: "model_missing", providerId };
    }

    const statuses = await checkAllProviderStatus();
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
