import type { SessionModelPreference } from "@/features/chat/lib/sessionModelPreference";
import type { StoredModelPreference } from "@/features/chat/lib/modelPreferences";
import type { DefaultProviderReadiness } from "../defaultProviderReadiness";
import { normalizeConcreteModelId } from "@/shared/lib/modelIdentity";

export interface NewSessionTargetPolicy {
  /** Restricted builds provide Goose defaults outside the BYO-key setup flow. */
  requireGooseDefaultProvider: boolean;
}

export type NewSessionTargetProvenance =
  | "explicit"
  | "persisted"
  | "goose_default"
  | "fallback";

export type NewSessionTargetResult =
  | ({
      status: "ready";
      provenance: NewSessionTargetProvenance;
    } & SessionModelPreference)
  | {
      status: "blocked";
      reason: "explicit_target_unready";
      providerId: string;
    }
  | { status: "needs_setup" };

export interface NewSessionTargetSnapshot {
  defaultProviderReadiness: DefaultProviderReadiness | null;
  readyAgentIds: ReadonlySet<string>;
  configuredAgentIds: ReadonlySet<string>;
  catalogAgentIds: readonly string[];
  persistedProviderId?: string | null;
  persistedModelPreference?: StoredModelPreference | null;
  policy: NewSessionTargetPolicy;
}

export interface NewSessionTargetRequest {
  providerId?: string;
  modelId?: string;
}

function isAgentReady(
  providerId: string,
  snapshot: NewSessionTargetSnapshot,
): boolean {
  if (providerId === "goose") {
    return (
      !snapshot.policy.requireGooseDefaultProvider ||
      snapshot.defaultProviderReadiness?.status !== "needs_setup"
    );
  }
  if (
    snapshot.defaultProviderReadiness?.status === "ready" &&
    snapshot.defaultProviderReadiness.providerId === providerId
  ) {
    return true;
  }
  return (
    snapshot.readyAgentIds.has(providerId) ||
    snapshot.configuredAgentIds.has(providerId)
  );
}

function readyTarget(
  providerId: string,
  modelId: string | undefined,
  provenance: NewSessionTargetProvenance,
): NewSessionTargetResult {
  const concreteModelId = normalizeConcreteModelId(modelId);
  return {
    status: "ready",
    provenance,
    providerId,
    modelId: concreteModelId,
    ...(concreteModelId ? { modelName: concreteModelId } : {}),
  };
}

/** Resolve one settled agent/model target for a new session. No I/O. */
export function resolveNewSessionTarget(
  snapshot: NewSessionTargetSnapshot,
  request: NewSessionTargetRequest = {},
): NewSessionTargetResult {
  if (request.providerId) {
    return isAgentReady(request.providerId, snapshot)
      ? readyTarget(
          request.providerId,
          request.modelId ??
            (request.providerId === "goose" &&
            snapshot.defaultProviderReadiness?.status === "ready"
              ? snapshot.defaultProviderReadiness.modelId
              : undefined),
          "explicit",
        )
      : {
          status: "blocked",
          reason: "explicit_target_unready",
          providerId: request.providerId,
        };
  }

  const persistedProviderId = snapshot.persistedProviderId ?? undefined;
  if (persistedProviderId && isAgentReady(persistedProviderId, snapshot)) {
    const persistedModelPreference = snapshot.persistedModelPreference;
    const persistedModelMatchesTarget =
      persistedModelPreference &&
      (persistedProviderId === "goose" ||
        !persistedModelPreference.providerId ||
        persistedModelPreference.providerId === persistedProviderId);
    if (persistedModelMatchesTarget) {
      const modelId = normalizeConcreteModelId(
        persistedModelPreference.modelId,
      );
      return {
        status: "ready",
        provenance: "persisted",
        providerId: persistedProviderId,
        modelId,
        modelName: modelId ? persistedModelPreference.modelName : undefined,
      };
    }

    return readyTarget(
      persistedProviderId,
      persistedProviderId === "goose" &&
        snapshot.defaultProviderReadiness?.status === "ready"
        ? snapshot.defaultProviderReadiness.modelId
        : undefined,
      "persisted",
    );
  }

  if (
    snapshot.defaultProviderReadiness?.status === "ready" &&
    isAgentReady("goose", snapshot)
  ) {
    return readyTarget(
      "goose",
      snapshot.defaultProviderReadiness.modelId,
      "goose_default",
    );
  }

  // Unknown readiness is not evidence of missing setup. Preserve the previous
  // fail-open contract and let the backend return an operational error rather
  // than mislabeling a transient defaults-read failure as configuration loss.
  if (isAgentReady("goose", snapshot)) {
    return readyTarget("goose", undefined, "goose_default");
  }

  const fallbackProviderId = snapshot.catalogAgentIds.find(
    (providerId) =>
      providerId !== "goose" && isAgentReady(providerId, snapshot),
  );
  return fallbackProviderId
    ? readyTarget(fallbackProviderId, undefined, "fallback")
    : { status: "needs_setup" };
}
