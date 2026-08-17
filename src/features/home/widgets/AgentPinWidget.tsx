import { memo, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { resolveAgentIcon } from "@/features/agents/lib/resolveAgentIcon";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useAvatarMedia } from "@/shared/hooks/useAvatarSrc";
import { AvatarMedia } from "@/shared/ui/avatar-media";
import { cn } from "@/shared/lib/cn";
import { useHomePinLabelsPreference } from "@/features/home/lib/homePinLabelPreference";
import { useWidgetActivationGuard } from "./useWidgetActivationGuard";
import { useWidgetGestureFreeze } from "./useWidgetGestureFreeze";
import type { WidgetRenderProps } from "./types";

function getAgentId(state: Record<string, unknown> | undefined): string | null {
  return typeof state?.agentId === "string" ? state.agentId : null;
}

export const AgentPinWidget = memo(function AgentPinWidget({
  instance,
  canvasGestureActive = false,
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
  const avatarHostRef = useRef<HTMLDivElement | null>(null);
  const pointerDownSnapshotRef = useRef<string | null>(null);
  const captureAvatarSnapshot = useCallback(() => {
    const host = avatarHostRef.current;
    if (!host) {
      return null;
    }

    const image = host.querySelector("img");
    if (image instanceof HTMLImageElement) {
      return image.currentSrc || image.src || null;
    }

    // Stacked-alpha avatars paint their visible frame to a canvas. Prefer it
    // over the hidden source video so the drag snapshot preserves transparency.
    const paintedCanvas = host.querySelector("canvas");
    if (
      paintedCanvas instanceof HTMLCanvasElement &&
      paintedCanvas.width > 0 &&
      paintedCanvas.height > 0
    ) {
      try {
        const snapshot = paintedCanvas.toDataURL("image/png");
        return snapshot && snapshot !== "data:," ? snapshot : null;
      } catch {
        return null;
      }
    }

    const video = host.querySelector("video");
    if (video instanceof HTMLVideoElement && video.videoWidth > 0) {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext("2d");
        if (!context) {
          return null;
        }
        context.drawImage(video, 0, 0);
        const snapshot = canvas.toDataURL("image/png");
        return snapshot && snapshot !== "data:," ? snapshot : null;
      } catch {
        return null;
      }
    }

    return null;
  }, []);
  const captureGestureSnapshot = useCallback(
    () => pointerDownSnapshotRef.current ?? captureAvatarSnapshot(),
    [captureAvatarSnapshot],
  );
  const handlePointerDown = () => {
    // Capture before the canvas relocates this widget. Moving video-backed
    // avatars can briefly expose a blank compositor frame in WKWebView.
    pointerDownSnapshotRef.current = captureAvatarSnapshot();
  };
  const clearPreparedSnapshot = () => {
    pointerDownSnapshotRef.current = null;
  };
  const gestureSnapshot = useWidgetGestureFreeze(
    canvasGestureActive,
    captureGestureSnapshot,
  );

  return (
    <div className="group pointer-events-none relative flex h-full w-full items-center justify-center text-center text-foreground">
      <button
        type="button"
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerUp={clearPreparedSnapshot}
        onPointerCancel={clearPreparedSnapshot}
        aria-label={t("widgets.agentPin.openAria", { name: label })}
        className="pointer-events-auto relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-full bg-transparent transition-colors duration-150 cursor-pointer outline-none hover:bg-transparent focus-visible:ring-2 focus-visible:ring-ring"
      >
        {gestureSnapshot ? (
          <img
            alt=""
            aria-hidden="true"
            src={gestureSnapshot}
            className="pointer-events-none absolute inset-0 z-10 h-full w-full object-contain"
          />
        ) : null}
        <div
          ref={avatarHostRef}
          className={cn("h-full w-full", gestureSnapshot && "invisible")}
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
