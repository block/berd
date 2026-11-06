import { i18n } from "@/shared/i18n";
import {
  acpGetPreparedWorkingDir,
  acpSetSessionConfigOption,
} from "@/shared/api/acp";
import {
  autoRoutingFallback,
  routeAutoModel,
  type AutoRoutingDecision,
} from "@/shared/api/autoRouting";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import { autoRoutingEfforts } from "@/shared/runtime-config/schema";
import type { ChatAttachmentDraft } from "@/shared/types/messages";
import { useChatSessionStore } from "../stores/chatSessionStore";
import { useChatStore } from "../stores/chatStore";
import { buildAutoRoutingPrompt } from "./autoRoutingPrompt";
import { selectAutoMode } from "./autoModelSelection";
import { PreCommitSendRejectedError } from "./preCommitSendRejection";
import {
  transitionSessionDispatchTarget,
  transitionSessionTarget,
  type SessionTargetOutcome,
} from "./sessionTargetCoordinator";

const EFFORTS: readonly string[] = autoRoutingEfforts;

/** Fresh prompts route once; steering bypasses dispatchPrompt entirely. */
export async function prepareAutoRoutedPrompt(
  sessionId: string,
  input: {
    text: string;
    assistantPrompt?: string;
    attachments?: ChatAttachmentDraft[];
    dispatchToken?: symbol;
    signal?: AbortSignal;
  },
): Promise<AutoRoutingDecision | undefined> {
  const session = useChatSessionStore.getState().getSession(sessionId);
  const modeId = session?.autoModeId;
  if (!modeId) return;
  const runtime = useRuntimeConfigStore.getState();
  const mode = runtime.config.goose.autoRouting?.modes.find(
    (candidate) => candidate.id === modeId,
  );
  if (!mode) {
    // Startup and failed loads expose defaults, not an authoritative config.
    // Retain intent until a successful load confirms the mode was removed.
    if (
      !runtime.loaded ||
      runtime.result.status !== "ready" ||
      runtime.result.source === "appDefault"
    ) {
      throw new PreCommitSendRejectedError(
        i18n.t("chat:errors.sessionPreparationSuperseded"),
      );
    }
    selectAutoMode(sessionId, null);
    return;
  }
  if (session.executionTarget?.harnessId !== "goose") return;
  const autoRoutingRevision =
    runtime.result.status === "ready"
      ? runtime.result.autoRoutingRevision
      : undefined;
  const routingSnapshot = JSON.stringify(runtime.config.goose.autoRouting);
  const assertCurrent = () => {
    if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const currentResult = useRuntimeConfigStore.getState().result;
    if (
      (currentResult.status === "ready"
        ? currentResult.autoRoutingRevision
        : undefined) !== autoRoutingRevision ||
      JSON.stringify(
        useRuntimeConfigStore.getState().config.goose.autoRouting,
      ) !== routingSnapshot ||
      useChatSessionStore.getState().getSession(sessionId)?.autoModeId !==
        modeId
    ) {
      throw new PreCommitSendRejectedError(
        i18n.t("chat:errors.sessionPreparationSuperseded"),
      );
    }
  };
  assertCurrent();
  const prompt = await buildAutoRoutingPrompt({
    ...input,
    messages: useChatStore.getState().messagesBySession[sessionId],
    remote: Boolean(session.remoteHost),
  });
  assertCurrent();
  let decision = await routeAutoModel({
    modeId,
    prompt,
    signal: input.signal,
    config: runtime.config.goose.autoRouting,
    autoRoutingRevision,
  });
  assertCurrent();
  let fallbackAttempted = decision.modelId === mode.fallback.modelId;
  let outcome: Extract<SessionTargetOutcome, { applied: true }>;
  for (;;) {
    const request = {
      sessionId,
      requireExactTarget: true,
      target: {
        harnessId: "goose" as const,
        modelProviderId: decision.modelProviderId,
        modelId: decision.modelId,
        modelName: decision.modelId,
      },
      // Routing changes only the model; preserve the send's resolved CWD.
      workingDir: acpGetPreparedWorkingDir(sessionId),
    };
    let attempt: SessionTargetOutcome;
    try {
      attempt = input.dispatchToken
        ? await transitionSessionDispatchTarget({
            ...request,
            dispatchToken: input.dispatchToken,
          })
        : await transitionSessionTarget(request);
    } catch (error) {
      assertCurrent();
      if (
        error instanceof PreCommitSendRejectedError ||
        (error instanceof Error && error.name === "AbortError") ||
        fallbackAttempted
      )
        throw error;
      decision = autoRoutingFallback(
        mode,
        "model_unavailable",
        decision.response,
      );
      fallbackAttempted = true;
      continue;
    }
    if (!attempt.applied) {
      throw new PreCommitSendRejectedError(
        i18n.t("chat:errors.sessionPreparationSuperseded"),
      );
    }
    assertCurrent();
    if (
      attempt.target.modelId === decision.modelId &&
      attempt.target.modelProviderId === decision.modelProviderId &&
      attempt.target.harnessId === "goose"
    ) {
      outcome = attempt;
      break;
    }
    // Inventory repair can substitute a model. Use only the configured
    // fallback, once, rather than sending on an unrequested substitute.
    if (fallbackAttempted)
      throw new Error(i18n.t("chat:errors.autoModelUnavailable"));
    decision = autoRoutingFallback(
      mode,
      "model_unavailable",
      decision.response,
    );
    fallbackAttempted = true;
  }
  const reasoning =
    outcome.configOptionsSnapshot?.reasoningEffort ??
    useChatSessionStore.getState().getSession(sessionId)?.reasoningEffort;
  if (reasoning?.options.length) {
    const candidate = mode.models.find(
      (model) => model.modelId === decision.modelId,
    );
    const lower = candidate?.minEffort
      ? EFFORTS.indexOf(candidate.minEffort)
      : 0;
    const upper = candidate?.maxEffort
      ? EFFORTS.indexOf(candidate.maxEffort)
      : EFFORTS.length - 1;
    const requested = EFFORTS.indexOf(decision.effort);
    const supported = reasoning.options
      .map((option) => ({ id: option.id, rank: EFFORTS.indexOf(option.id) }))
      .filter((option) => option.rank >= lower && option.rank <= upper)
      .sort(
        (a, b) =>
          Math.abs(a.rank - requested) - Math.abs(b.rank - requested) ||
          b.rank - a.rank,
      );
    const selected = supported[0];
    if (!selected) throw new Error(i18n.t("chat:errors.autoEffortUnavailable"));
    if (selected.id !== reasoning.currentValue) {
      await acpSetSessionConfigOption(
        sessionId,
        reasoning.configId,
        selected.id,
        {
          providerId: decision.modelProviderId,
          modelId: decision.modelId,
          reasoningEffortValue: selected.id,
        },
      );
      assertCurrent();
    }
    useChatSessionStore.getState().patchSession(sessionId, {
      reasoningEffort: { ...reasoning, currentValue: selected.id },
    });
    decision.effortApplied = selected.id;
  }
  useChatSessionStore
    .getState()
    .patchSession(sessionId, { autoRoutingDecision: decision });
  return decision;
}
