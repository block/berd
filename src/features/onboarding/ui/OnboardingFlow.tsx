import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createPersona, listPersonas } from "@/shared/api/agents";
import {
  avatarCachedRefQueryKey,
  getCachedAvatarForRef,
} from "@/shared/api/avatars";
import {
  ARTIFACTS_QUERY_KEY,
  getArtifacts,
  selectAvatarImageUrl,
} from "@/shared/api/artifacts";
import { parseAvatarRef } from "@/shared/avatars/catalog";
import { toast } from "sonner";
import { i18n } from "@/shared/i18n";
import { CURATED_PROVIDER_CATALOG_BY_ID } from "@/features/providers/curatedProviders";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import {
  dispatchOnboarding,
  isWorkTypeId,
  recommendationsForWorkTypes,
  type CuratedHarnessId,
  type RecommendedAgent,
  useOnboardingState,
} from "../model";
import { WelcomeStep } from "./WelcomeStep";
import { WorkTypesStep } from "./WorkTypesStep";
import { RecommendationsStep } from "./RecommendationsStep";
import { HarnessStep } from "./HarnessStep";
import { HarnessSetupStep } from "./HarnessSetupStep";

interface AgentAdoptionResult {
  adopted: string[];
  failures: string[];
}

async function adoptAgents(
  agents: RecommendedAgent[],
): Promise<AgentAdoptionResult> {
  const failures: string[] = [];
  const adopted: string[] = [];
  const existingNames = new Set(
    (await listPersonas()).map((persona) => persona.displayName.toLowerCase()),
  );
  for (const agent of agents) {
    if (existingNames.has(agent.canonicalName.toLowerCase())) {
      adopted.push(agent.canonicalName);
      continue;
    }
    try {
      const persona = await createPersona({
        displayName: agent.canonicalName,
        avatar: agent.avatar,
        systemPrompt: `You are ${agent.canonicalName}, ${agent.canonicalPromptDescription.toLowerCase()} Help the user thoughtfully and directly.`,
      });
      useAgentStore.getState().addPersona(persona);
      existingNames.add(agent.canonicalName.toLowerCase());
      adopted.push(agent.canonicalName);
    } catch {
      failures.push(agent.canonicalName);
    }
  }
  return { adopted, failures };
}

function decodeImage(src: string | undefined): void {
  if (!src) return;
  const image = new Image();
  image.src = src;
  void image.decode?.().catch(() => {});
}

export function OnboardingFlow() {
  const state = useOnboardingState();
  const queryClient = useQueryClient();
  const selectedWorkTypes = state.selectedWorkTypeIds.filter(isWorkTypeId);
  const recommendations = recommendationsForWorkTypes(selectedWorkTypes);
  const recommendedAvatarRefs = recommendations.map((agent) => agent.avatar);
  const recommendedAvatarKey = recommendedAvatarRefs.join("|");
  useEffect(() => {
    if (state.step !== "work-types") return;
    void queryClient
      .fetchQuery({
        queryKey: ARTIFACTS_QUERY_KEY,
        queryFn: getArtifacts,
        staleTime: 24 * 60 * 60 * 1000,
      })
      .then((artifacts) => {
        for (const avatarRef of recommendedAvatarKey.split("|")) {
          const avatarId = parseAvatarRef(avatarRef);
          if (avatarId) {
            decodeImage(selectAvatarImageUrl(artifacts, avatarId));
          }
        }
      })
      .catch(() => {
        // Preloading is best-effort; Step 2 retains its normal placeholders.
      });
    for (const avatarRef of recommendedAvatarKey.split("|")) {
      void queryClient.prefetchQuery({
        queryKey: avatarCachedRefQueryKey(avatarRef),
        queryFn: () => getCachedAvatarForRef({ avatarRef }),
      });
    }
  }, [queryClient, recommendedAvatarKey, state.step]);
  const finish = () => dispatchOnboarding({ type: "complete" });
  const finishWithSelectedProvider = () => {
    if (state.selectedHarnessId) {
      useAgentStore.getState().setSelectedProvider(state.selectedHarnessId);
    }
    finish();
  };

  if (state.step === "welcome") {
    return (
      <WelcomeStep
        onStart={() =>
          dispatchOnboarding({ type: "go-to", step: "work-types" })
        }
      />
    );
  }
  if (state.step === "work-types") {
    return (
      <WorkTypesStep
        selectedIds={state.selectedWorkTypeIds}
        onToggle={(workTypeId) =>
          dispatchOnboarding({ type: "toggle-work-type", workTypeId })
        }
        onBack={() => dispatchOnboarding({ type: "go-to", step: "welcome" })}
        onNext={() =>
          dispatchOnboarding({ type: "go-to", step: "recommendations" })
        }
      />
    );
  }
  if (state.step === "recommendations") {
    return (
      <RecommendationsStep
        agents={recommendations}
        onBack={() => dispatchOnboarding({ type: "go-to", step: "work-types" })}
        onKeep={async () => {
          const result = await adoptAgents(recommendations);
          if (result.failures.length > 0) {
            toast.warning(
              i18n.t("recommendations.partialAdoptionWarning", {
                ns: "onboarding",
                names: result.failures.join(", "),
              }),
            );
          }
          dispatchOnboarding({ type: "go-to", step: "harness" });
        }}
        onSkip={() => dispatchOnboarding({ type: "go-to", step: "harness" })}
      />
    );
  }
  if (state.step === "harness") {
    return (
      <HarnessStep
        selectedId={state.selectedHarnessId}
        onSelect={(harnessId: CuratedHarnessId) =>
          dispatchOnboarding({ type: "select-harness", harnessId })
        }
        onBack={() =>
          dispatchOnboarding({ type: "go-to", step: "recommendations" })
        }
        onNext={() => {
          const provider = state.selectedHarnessId
            ? CURATED_PROVIDER_CATALOG_BY_ID.get(state.selectedHarnessId)
            : undefined;
          if (!provider) return;
          if (provider.setupMethod === "none") {
            dispatchOnboarding({
              type: "complete-harness-setup",
              harnessId: provider.id,
            });
            finishWithSelectedProvider();
          } else {
            dispatchOnboarding({ type: "go-to", step: "harness-setup" });
          }
        }}
        onSkip={finish}
      />
    );
  }
  if (state.step === "harness-setup") {
    const provider = state.selectedHarnessId
      ? CURATED_PROVIDER_CATALOG_BY_ID.get(state.selectedHarnessId)
      : undefined;
    if (!provider) return null;
    return (
      <HarnessSetupStep
        provider={provider}
        initiallyComplete={state.completedHarnessSetupIds.includes(provider.id)}
        onSetupComplete={() =>
          dispatchOnboarding({
            type: "complete-harness-setup",
            harnessId: provider.id,
          })
        }
        onBack={() => dispatchOnboarding({ type: "go-to", step: "harness" })}
        onComplete={finishWithSelectedProvider}
        onSkip={finish}
      />
    );
  }
  return null;
}
