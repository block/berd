import { useTranslation } from "react-i18next";
import { IconUser } from "@tabler/icons-react";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useWidgetActivationGuard } from "./useWidgetActivationGuard";
import type { WidgetRenderProps } from "./types";

function getAgentId(state: Record<string, unknown> | undefined): string | null {
  return typeof state?.agentId === "string" ? state.agentId : null;
}

export function AgentPinWidget({
  instance,
  shouldIgnoreActivation,
  onOpenAgent,
}: WidgetRenderProps) {
  const { t } = useTranslation("home");
  const personas = useAgentStore((state) => state.personas);

  const agentId = getAgentId(instance.state);
  const persona =
    personas.find((p) => p.id === agentId) ??
    personas.find((p) => p.isBuiltin) ??
    personas[0];
  const label = persona?.displayName ?? t("widgets.agentPin.fallbackName");
  const personaId = persona?.id ?? agentId ?? "goose";
  const handleClick = useWidgetActivationGuard(shouldIgnoreActivation, () =>
    onOpenAgent?.(personaId),
  );

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={t("widgets.agentPin.openAria", { name: label })}
      className="flex h-full w-full flex-col rounded-card-chat border border-border-soft bg-surface-card p-4 text-left text-foreground transition-colors duration-150 hover:bg-surface-tile cursor-pointer"
    >
      <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <IconUser className="size-4" aria-hidden="true" />
        {t("widgets.agentPin.kicker")}
      </span>
      <span className="mt-3 truncate text-base leading-5">{label}</span>
    </button>
  );
}
