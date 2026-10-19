import {
  autoRoutingEfforts,
  type AutoRoutingEffort,
  type RuntimeAutoRoutingConfig,
  type RuntimeAutoRoutingMode,
  type RuntimeAutoRoutingModel,
} from "@/shared/runtime-config/schema";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import { PreCommitSendRejectedError } from "@/features/chat/lib/preCommitSendRejection";
import { i18n } from "@/shared/i18n";
import { invokeWithStartupRetry } from "./invokeWithStartupRetry";

const AUTO_ROUTING_CONFIG_CHANGED = "AUTO_ROUTING_CONFIG_CHANGED";

export interface AutoRoutingResult {
  modeId: string;
  source: "router" | "fallback";
  rationale?: string;
  fallbackReason?: string;
  response?: unknown;
  effortApplied?: string;
  modelProviderId: string;
  modelId: string;
  effort: AutoRoutingEffort;
}
export type AutoRoutingDecision = AutoRoutingResult;

export function buildAutoRoutingRequest(
  mode: RuntimeAutoRoutingMode,
  prompt: string,
  config: RuntimeAutoRoutingConfig,
) {
  return {
    route_options: mode.models.map((model) => ({
      model: model.routerModel,
      harness: model.harness ?? "codex",
      ...(model.minEffort ? { min_effort: model.minEffort } : {}),
      ...(model.maxEffort ? { max_effort: model.maxEffort } : {}),
    })),
    task: { prompt },
    ...(config.routeSelector ? { route_selector: config.routeSelector } : {}),
  };
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function normalizedModel(value: string) {
  return value.replace(/^system\.ai\./, "").replace(/(\d)\.(?=\d)/g, "$1-");
}
function boundedEffort(
  model: RuntimeAutoRoutingModel,
  effort: AutoRoutingEffort,
): AutoRoutingEffort {
  const min = autoRoutingEfforts.indexOf(model.minEffort ?? "none");
  const max = autoRoutingEfforts.indexOf(model.maxEffort ?? "max");
  return autoRoutingEfforts[
    Math.max(min, Math.min(max, autoRoutingEfforts.indexOf(effort)))
  ];
}
export function autoRoutingFallback(
  mode: RuntimeAutoRoutingMode,
  reason: string,
  response?: unknown,
): AutoRoutingResult {
  return {
    modeId: mode.id,
    modelProviderId: mode.modelProviderId,
    ...mode.fallback,
    source: "fallback",
    fallbackReason: reason,
    ...(response === undefined ? {} : { response }),
  };
}
/** Only configured candidates may be selected. Preserve opaque server diagnostics in memory. */
export function selectAutoRoutingResponse(
  mode: RuntimeAutoRoutingMode,
  response: unknown,
): AutoRoutingResult {
  const body = record(response);
  const selections = body?.route_selection;
  if (!Array.isArray(selections) || selections.length !== 1)
    return autoRoutingFallback(mode, "invalid_response", response);
  const selection = record(selections[0]);
  const option = record(selection?.route_option);
  if (typeof option?.model !== "string" || typeof option.harness !== "string")
    return autoRoutingFallback(mode, "invalid_response", response);
  const candidate = mode.models.find(
    (model) =>
      normalizedModel(model.routerModel) ===
        normalizedModel(option.model as string) &&
      (model.harness ?? "codex") === option.harness,
  );
  if (!candidate)
    return autoRoutingFallback(mode, "unconfigured_model", response);
  const params = record(selection?.params);
  const effort =
    params?.reasoning_effort ?? params?.effort ?? selection?.effort;
  if (
    effort !== undefined &&
    (typeof effort !== "string" ||
      !autoRoutingEfforts.includes(effort as AutoRoutingEffort))
  )
    return autoRoutingFallback(mode, "invalid_effort", response);
  return {
    modeId: mode.id,
    modelProviderId: mode.modelProviderId,
    modelId: candidate.modelId,
    effort: boundedEffort(candidate, (effort ?? "medium") as AutoRoutingEffort),
    source: "router",
    response,
    ...(typeof body?.rationale === "string"
      ? { rationale: body.rationale }
      : {}),
  };
}

function abortableResponse<T>(
  request: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return request;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    // The native request may finish later. Observe both outcomes without
    // allowing a cancelled turn to select or apply a model from its result.
    request.then(
      (response) => {
        signal.removeEventListener("abort", onAbort);
        resolve(response);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function routeAutoModel({
  modeId,
  prompt,
  signal,
  config = useRuntimeConfigStore.getState().config.goose.autoRouting,
}: {
  modeId: string;
  prompt: string;
  signal?: AbortSignal;
  config?: RuntimeAutoRoutingConfig;
}): Promise<AutoRoutingResult> {
  const mode = config?.modes.find((entry) => entry.id === modeId);
  if (!mode) throw new Error("Auto routing mode is not configured");
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  try {
    // The caller's snapshot is only an equality guard. Native still resolves
    // URL, credentials and candidates from its trusted runtime configuration.
    const response = await abortableResponse(
      invokeWithStartupRetry<unknown>("route_auto_model", {
        modeId,
        prompt,
        expectedAutoRouting: config,
      }),
      signal,
    );
    return selectAutoRoutingResponse(mode, response);
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (
      (error instanceof Error ? error.message : error) ===
      AUTO_ROUTING_CONFIG_CHANGED
    ) {
      // Other windows refresh the shared native cache independently of this
      // renderer. Read that effective cache before the queue retries; this
      // does not refresh the source or create a new-chat config boundary.
      try {
        const result = await abortableResponse(
          useRuntimeConfigStore.getState().load(),
          signal,
        );
        if (
          result.status !== "ready" ||
          JSON.stringify(result.config.goose.autoRouting) ===
            JSON.stringify(config)
        ) {
          throw new Error("Runtime configuration resync unavailable");
        }
      } catch {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        // A persistent sync failure must use the ordinary failure path. The
        // background queue immediately retries pre-commit rejections.
        throw new Error(i18n.t("chat:errors.autoModelUnavailable"));
      }
      throw new PreCommitSendRejectedError(
        i18n.t("chat:errors.sessionPreparationSuperseded"),
      );
    }
    // Error messages may contain endpoint details; diagnostics use stable local codes.
    return autoRoutingFallback(mode, "request_failed");
  }
}
