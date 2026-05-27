import { memo } from "react";
import { useTranslation } from "react-i18next";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useAvatarMedia } from "@/shared/hooks/useAvatarSrc";
import { AvatarMedia } from "@/shared/ui/avatar-media";
import { useWidgetActivationGuard } from "./useWidgetActivationGuard";
import type { WidgetRenderProps } from "./types";

function getAgentId(state: Record<string, unknown> | undefined): string | null {
  return typeof state?.agentId === "string" ? state.agentId : null;
}

function avatarInitial(label: string): string {
  const trimmed = label.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : "?";
}

export const AgentPinWidget = memo(function AgentPinWidget({
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
  const avatarMedia = useAvatarMedia(persona?.avatar);
  const handleClick = useWidgetActivationGuard(shouldIgnoreActivation, () =>
    onOpenAgent?.(personaId),
  );

  return (
    <div className="flex h-full w-full items-center justify-center p-4">
      <button
        type="button"
        onClick={handleClick}
        aria-label={t("widgets.agentPin.openAria", { name: label })}
        className="group relative flex w-[min(80%,176px)] max-w-full flex-col items-center justify-center rounded-card-chat bg-transparent text-center text-foreground transition-colors duration-150 cursor-pointer outline-none hover:bg-transparent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <span className="flex aspect-square w-full shrink-0 items-center justify-center overflow-hidden">
          {avatarMedia ? (
            <AvatarMedia
              media={avatarMedia}
              alt=""
              loadingStrategy="visible-video"
              className="pointer-events-none object-contain"
            />
          ) : (
            <span
              aria-hidden="true"
              className="flex size-full items-center justify-center rounded-full bg-foreground text-[2.5rem] font-medium text-background"
            >
              {avatarInitial(label)}
            </span>
          )}
        </span>
        <span
          data-testid="agent-pin-hover-label"
          className="pointer-events-none absolute top-full left-1/2 z-10 mt-2 max-w-[calc(100vw-2rem)] -translate-x-1/2 truncate whitespace-nowrap rounded-full bg-white/90 px-2.5 py-1 text-xs font-medium text-[#242424] opacity-0 backdrop-blur-md transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          {label}
        </span>
      </button>
    </div>
  );
});
