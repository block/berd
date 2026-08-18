import { useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import { useAvatarImage, useAvatarMedia } from "@/shared/hooks/useAvatarSrc";
import { AvatarMedia } from "@/shared/ui/avatar-media";
import { cn } from "@/shared/lib/cn";
import type { OnboardingRuntimeState, RecommendedAgent } from "../model";
import { OnboardingShell } from "./OnboardingShell";

function AgentChoice({
  agent,
  expanded,
  onToggle,
}: {
  agent: RecommendedAgent;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation("onboarding");
  const avatar = useAvatarImage(agent.avatar);
  const avatarMedia = useAvatarMedia(agent.avatar);
  const [videoFrameReady, setVideoFrameReady] = useState(false);
  const reduceMotion = useReducedMotion();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="flex h-[clamp(368px,50vh,508px)] w-[clamp(280px,28vw,380px)] min-w-[280px] flex-none flex-col items-center focus-visible:outline-2 focus-visible:outline-offset-4"
    >
      <div className="relative flex min-h-[220px] max-h-[360px] w-full flex-1 items-end justify-center overflow-hidden">
        {avatarMedia ? (
          <AvatarMedia
            media={avatarMedia}
            alt=""
            loadingStrategy="eager"
            playbackMode="occasional"
            onReady={() => setVideoFrameReady(true)}
            className={cn(
              "absolute inset-0 h-full w-full object-contain object-bottom transition-opacity duration-150",
              avatarMedia.mediaType === "video" && !videoFrameReady
                ? "opacity-0"
                : "opacity-100",
            )}
          />
        ) : avatar ? (
          <img
            src={avatar}
            alt=""
            className="absolute inset-0 h-full w-full object-contain object-bottom"
          />
        ) : (
          <div className="size-56 rounded-full bg-muted" />
        )}
      </div>
      <div
        className={cn(
          "relative mt-5 flex flex-col overflow-hidden rounded-[18px] bg-card text-sm",
          reduceMotion
            ? "transition-none"
            : "transition-[width] duration-300 ease-out",
          expanded ? "w-[250px]" : "w-[96px]",
          "h-fit shrink-0",
        )}
      >
        <div className="flex h-9 shrink-0 items-center justify-center px-3">
          <span className="truncate">
            {t(`recommendations.agents.${agent.id}.name`)}
          </span>
        </div>
        <AnimatePresence initial={false}>
          {expanded ? (
            <motion.div
              initial={reduceMotion ? false : { height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.2 }}
              className="mx-auto -mt-1 w-[218px] px-4 pb-3 text-center text-muted-foreground"
            >
              {t(`recommendations.agents.${agent.id}.description`)}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </button>
  );
}

interface RecommendationsStepProps {
  agents: RecommendedAgent[];
  // Keeping agents creates personas over ACP, so this step is the one that has
  // to wait for the chat runtime the surrounding flow no longer waits for.
  runtime: OnboardingRuntimeState;
  onBack: () => void;
  onKeep: () => Promise<void>;
  onSkip: () => void;
}

export function RecommendationsStep({
  agents,
  runtime,
  onBack,
  onKeep,
  onSkip,
}: RecommendationsStepProps) {
  const { t } = useTranslation("onboarding");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  // Startup has neither settled nor failed yet: agents cannot be created, but
  // the step still renders and Skip still works.
  const runtimeStarting = !runtime.ready && !runtime.failed;

  const keep = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await onKeep();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("recommendations.genericError"),
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <OnboardingShell
      onBack={onBack}
      backDisabled={saving}
      title={t("recommendations.title")}
      description={t("recommendations.description")}
      actions={
        <>
          {error ? (
            <p role="alert" className="text-center text-xs text-destructive">
              {error}
            </p>
          ) : null}
          {runtime.failed ? (
            <>
              <p role="alert" className="text-center text-xs text-destructive">
                {t("recommendations.runtimeUnavailable")}
              </p>
              <Button type="button" onClick={runtime.retry}>
                {t("recommendations.retryRuntime")}
              </Button>
            </>
          ) : (
            // A loading feedback state also disables the button, so Keep cannot
            // fire an ACP call while the runtime is still starting.
            <Button
              type="button"
              onClick={() => void keep()}
              feedbackState={saving || runtimeStarting ? "loading" : "idle"}
              loadingLabel={
                saving
                  ? t("recommendations.adopting")
                  : t("recommendations.waitingForRuntime")
              }
            >
              {t("recommendations.keep")}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={onSkip}
            disabled={saving}
          >
            {t("recommendations.skip")}
          </Button>
        </>
      }
    >
      <div className="w-full overflow-x-auto">
        <div className="mx-auto flex w-max min-w-full items-start justify-center gap-[clamp(24px,4vw,48px)] px-10">
          {agents.map((agent) => (
            <AgentChoice
              key={agent.id}
              agent={agent}
              expanded={expandedId === agent.id}
              onToggle={() =>
                setExpandedId((current) =>
                  current === agent.id ? null : agent.id,
                )
              }
            />
          ))}
        </div>
      </div>
    </OnboardingShell>
  );
}
