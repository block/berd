import { memo } from "react";
import { useTranslation } from "react-i18next";
import { IconUser } from "@tabler/icons-react";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useAvatarMedia } from "@/shared/hooks/useAvatarSrc";
import { cn } from "@/shared/lib/cn";
import { AvatarMedia } from "@/shared/ui/avatar-media";
import { useWidgetActivationGuard } from "./useWidgetActivationGuard";
import type { WidgetRenderProps } from "./types";

function getAgentId(state: Record<string, unknown> | undefined): string | null {
  return typeof state?.agentId === "string" ? state.agentId : null;
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
        className={cn(
          "flex flex-col rounded-card-chat p-4 text-foreground transition-colors duration-150 cursor-pointer",
          avatarMedia
            ? "h-full w-full items-center justify-center gap-2 border border-transparent bg-transparent text-center hover:bg-transparent"
            : "h-24 w-[200px] border border-border-soft bg-surface-card text-left hover:bg-surface-tile",
        )}
      >
        {avatarMedia ? (
          <>
            <span className="flex aspect-square w-[min(80%,176px)] shrink-0 items-center justify-center overflow-hidden">
              <AvatarMedia
                media={avatarMedia}
                alt=""
                loadingStrategy="visible-video"
                className="object-contain"
              />
            </span>
            <span className="max-w-full truncate text-base leading-5">
              {label}
            </span>
          </>
        ) : (
          <>
            <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <IconUser className="size-4" aria-hidden="true" />
              {t("widgets.agentPin.kicker")}
            </span>
            <span className="mt-3 truncate text-base leading-5">{label}</span>
          </>
        )}
      </button>
    </div>
  );
});
