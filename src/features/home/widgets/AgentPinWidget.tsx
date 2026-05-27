import { memo } from "react";
import { useTranslation } from "react-i18next";
import { resolveAgentIcon } from "@/features/agents/lib/resolveAgentIcon";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useAvatarMedia } from "@/shared/hooks/useAvatarSrc";
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
  const fallbackIconSrc = resolveAgentIcon(personaId);
  const handleClick = useWidgetActivationGuard(shouldIgnoreActivation, () =>
    onOpenAgent?.(personaId),
  );

  return (
    // Box is aspect-locked to ratio (label-band + square-avatar), so the
    // wrapper here can fill it edge-to-edge with no padding. Outer div stays
    // pointer-events: none defensively; the avatar button and label each
    // re-enable pointer events on themselves.
    <div className="pointer-events-none flex h-full w-full flex-col text-center text-foreground">
      <button
        type="button"
        onClick={handleClick}
        aria-label={t("widgets.agentPin.openAria", { name: label })}
        className="pointer-events-auto relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-full bg-transparent transition-colors duration-150 cursor-pointer outline-none hover:bg-transparent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
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
      </button>
      <span
        className="pointer-events-auto block w-full shrink-0 truncate"
        style={{
          fontSize:
            "clamp(0.6875rem, calc(0.875rem * var(--widget-scale, 1)), 1.75rem)",
          lineHeight:
            "clamp(0.875rem, calc(1.125rem * var(--widget-scale, 1)), 2.25rem)",
        }}
      >
        {label}
      </span>
    </div>
  );
});
