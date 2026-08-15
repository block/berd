import { memo } from "react";
import { useTranslation } from "react-i18next";
import { resolveAgentIcon } from "@/features/agents/lib/resolveAgentIcon";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useAvatarMedia } from "@/shared/hooks/useAvatarSrc";
import { AvatarMedia } from "@/shared/ui/avatar-media";
import { cn } from "@/shared/lib/cn";
import { useHomePinLabelsPreference } from "@/features/home/lib/homePinLabelPreference";
import { useWidgetActivationGuard } from "./useWidgetActivationGuard";
import type { WidgetRenderProps } from "./types";

function getAgentId(state: Record<string, unknown> | undefined): string | null {
  return typeof state?.agentId === "string" ? state.agentId : null;
}

export const AgentPinWidget = memo(function AgentPinWidget({
  instance,
  shouldIgnoreActivation,
  onOpenAgent,
  onTagAgentInComposer,
}: WidgetRenderProps) {
  const { t } = useTranslation("home");
  const personas = useAgentStore((state) => state.personas);
  const { enabled: alwaysShowLabel } = useHomePinLabelsPreference();

  const agentId = getAgentId(instance.state);
  const persona =
    personas.find((p) => p.id === agentId) ??
    personas.find((p) => p.isBuiltin) ??
    personas[0];
  const label = persona?.displayName ?? t("widgets.agentPin.fallbackName");
  const personaId = persona?.id ?? agentId ?? "goose";
  const avatarMedia = useAvatarMedia(persona?.avatar);
  const fallbackIconSrc = resolveAgentIcon(personaId);
  const handleClick = useWidgetActivationGuard(shouldIgnoreActivation, () =>
    (onTagAgentInComposer ?? onOpenAgent)?.(personaId),
  );
  return (
    <div className="group pointer-events-none relative flex h-full w-full items-center justify-center text-center text-foreground">
      <button
        type="button"
        onClick={handleClick}
        aria-label={t("widgets.agentPin.openAria", { name: label })}
        className="pointer-events-auto relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-full bg-transparent transition-colors duration-150 cursor-pointer outline-none hover:bg-transparent focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="h-full w-full">
          {avatarMedia ? (
            <AvatarMedia
              media={avatarMedia}
              alt=""
              loadingStrategy="eager"
              className="pointer-events-none h-full w-full object-contain"
            />
          ) : (
            <img
              aria-hidden="true"
              alt=""
              src={fallbackIconSrc}
              className="pointer-events-none h-full w-full object-contain"
            />
          )}
        </div>
      </button>
      <span
        aria-hidden="true"
        data-testid="agent-pin-hover-label"
        className={cn(
          "pointer-events-none absolute bottom-1 left-1/2 z-10 max-w-[calc(100%-1.5rem)] -translate-x-1/2 translate-y-2 truncate whitespace-nowrap rounded-full bg-card/90 px-2.5 py-1 text-xs font-medium text-foreground backdrop-blur-md transition-opacity duration-150",
          alwaysShowLabel
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
        )}
      >
        {label}
      </span>
    </div>
  );
});
