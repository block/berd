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
    <div className="flex h-full w-full items-center justify-center">
      <button
        type="button"
        onClick={handleClick}
        aria-label={t("widgets.agentPin.openAria", { name: label })}
        className="flex h-full w-full flex-col items-center justify-center gap-2 rounded-card-chat bg-transparent p-4 text-center text-foreground transition-colors duration-150 cursor-pointer hover:bg-transparent"
      >
        <span className="flex aspect-square w-[min(80%,176px)] shrink-0 items-center justify-center overflow-hidden">
          {avatarMedia ? (
            <AvatarMedia
              media={avatarMedia}
              alt=""
              loadingStrategy="visible-video"
              className="object-contain"
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
        <span className="max-w-full truncate text-sm leading-[15px]">
          {label}
        </span>
      </button>
    </div>
  );
});
