import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  type MotionValue,
} from "motion/react";
import { selectAvatarImageUrl } from "@/shared/api/artifacts";
import { useHomePinLabelsPreference } from "@/features/home/lib/homePinLabelPreference";
import { useArtifacts } from "@/shared/hooks/useArtifacts";
import { useAvatarMedia } from "@/shared/hooks/useAvatarSrc";
import { cn } from "@/shared/lib/cn";
import { AvatarMedia } from "@/shared/ui/avatar-media";
import { Button } from "@/shared/ui/button";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { findBerdyPersonaId } from "@/features/onboarding/berdyAgent";
import type { WidgetRenderProps } from "./types";
import { useWidgetActivationGuard } from "./useWidgetActivationGuard";

const SETTLED_BUBBLE_PATH =
  "M 16 0 C 7 0 0 4 0 8 C 0 40 0 72 0 104 C 0 108 7 112 16 112 C 90 112 198 112 272 112 C 281 112 288 108 288 104 C 288 72 288 40 288 8 C 288 4 281 0 272 0 C 196 0 91 0 16 0 Z";

const SWAY_X_SPRING = { stiffness: 110, damping: 12, mass: 0.85 };
const SWAY_Y_SPRING = { stiffness: 190, damping: 24, mass: 0.7 };
const SWAY_ROTATION_SPRING = { stiffness: 140, damping: 16, mass: 0.7 };

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function directionLockedVelocity(velocity: { x: number; y: number }) {
  const x = Math.abs(velocity.x) < 0.2 ? 0 : velocity.x;
  const y = Math.abs(velocity.y) < 0.2 ? 0 : velocity.y;

  if (Math.abs(x) > Math.abs(y) * 1.35) return { x, y: 0 };
  if (Math.abs(y) > Math.abs(x) * 1.35) return { x: 0, y };
  return { x, y };
}

function useBerdySway(canvasDragPosition?: { x: number; y: number }) {
  const shouldReduceMotion = useReducedMotion();
  const lastDragPositionRef = useRef<{
    x: number;
    y: number;
    timestamp: number;
  } | null>(null);
  const dragVelocityRef = useRef({ x: 0, y: 0 });
  const swayTargetX = useMotionValue(0);
  const swayTargetY = useMotionValue(0);
  const swayTargetRotate = useMotionValue(0);
  const swayX = useSpring(swayTargetX, SWAY_X_SPRING);
  const swayY = useSpring(swayTargetY, SWAY_Y_SPRING);
  const swayRotate = useSpring(swayTargetRotate, SWAY_ROTATION_SPRING);

  useEffect(() => {
    const settle = () => {
      swayTargetX.set(0);
      swayTargetY.set(0);
      swayTargetRotate.set(0);
    };

    if (shouldReduceMotion || !canvasDragPosition) {
      lastDragPositionRef.current = null;
      dragVelocityRef.current = { x: 0, y: 0 };
      settle();
      return;
    }

    const timestamp = performance.now();
    const lastPosition = lastDragPositionRef.current;
    lastDragPositionRef.current = { ...canvasDragPosition, timestamp };
    if (!lastPosition) return;

    const elapsed = clamp(timestamp - lastPosition.timestamp, 8, 40);
    const frameScale = 1000 / 60 / elapsed;
    const measuredVelocity = {
      x: (canvasDragPosition.x - lastPosition.x) * frameScale,
      y: (canvasDragPosition.y - lastPosition.y) * frameScale,
    };
    const previousVelocity = dragVelocityRef.current;
    const velocity = {
      x: previousVelocity.x * 0.45 + measuredVelocity.x * 0.55,
      y: previousVelocity.y * 0.45 + measuredVelocity.y * 0.55,
    };
    dragVelocityRef.current = velocity;
    const directionalVelocity = directionLockedVelocity(velocity);

    swayTargetX.set(clamp(-directionalVelocity.x * 1.6, -22, 22));
    swayTargetY.set(clamp(-directionalVelocity.y * 0.55, -8, 8));
    swayTargetRotate.set(clamp(-directionalVelocity.x * 0.5, -8, 8));

    const settleTimer = window.setTimeout(settle, 88);
    return () => window.clearTimeout(settleTimer);
  }, [
    canvasDragPosition,
    shouldReduceMotion,
    swayTargetRotate,
    swayTargetX,
    swayTargetY,
  ]);

  return { swayX, swayY, swayRotate };
}

export function OnboardingTourWidget({
  instance,
  onUpdateState,
  shouldIgnoreActivation,
  onStartOnboardingTour,
  onOpenAgent,
  onTagAgentInComposer,
  onResolveBerdyAgent,
  canvasDragPosition,
}: WidgetRenderProps) {
  const sway = useBerdySway(canvasDragPosition);

  return (
    <BerdyContent
      welcomeDismissed={instance.state?.welcomeDismissed === true}
      onUpdateState={onUpdateState}
      shouldIgnoreActivation={shouldIgnoreActivation}
      onStartOnboardingTour={onStartOnboardingTour}
      onOpenAgent={onOpenAgent}
      onTagAgentInComposer={onTagAgentInComposer}
      onResolveBerdyAgent={onResolveBerdyAgent}
      {...sway}
    />
  );
}

interface BerdyContentProps {
  welcomeDismissed: boolean;
  onUpdateState: WidgetRenderProps["onUpdateState"];
  shouldIgnoreActivation: WidgetRenderProps["shouldIgnoreActivation"];
  onStartOnboardingTour: WidgetRenderProps["onStartOnboardingTour"];
  onOpenAgent: WidgetRenderProps["onOpenAgent"];
  onTagAgentInComposer: WidgetRenderProps["onTagAgentInComposer"];
  onResolveBerdyAgent: WidgetRenderProps["onResolveBerdyAgent"];
  swayX: MotionValue<number>;
  swayY: MotionValue<number>;
  swayRotate: MotionValue<number>;
}

const BerdyContent = memo(function BerdyContent({
  welcomeDismissed,
  onUpdateState,
  shouldIgnoreActivation,
  onStartOnboardingTour,
  onOpenAgent,
  onTagAgentInComposer,
  onResolveBerdyAgent,
  swayX,
  swayY,
  swayRotate,
}: BerdyContentProps) {
  const { t } = useTranslation("home");
  const { enabled: alwaysShowLabel } = useHomePinLabelsPreference();
  const shouldReduceMotion = useReducedMotion();
  const bubbleShadowId = `berdy-bubble-shadow-${useId().replace(/:/g, "")}`;
  const [isBubbleSettled, setIsBubbleSettled] = useState(false);
  const [isResolvingBerdy, setIsResolvingBerdy] = useState(false);
  const mountedRef = useRef(true);
  const resolveAttemptRef = useRef(0);
  const personas = useAgentStore((state) => state.personas);
  const personasLoading = useAgentStore((state) => state.personasLoading);
  const berdyPersonaId = findBerdyPersonaId(personas);
  const gloopyPoster = useArtifacts({
    select: (artifacts) => selectAvatarImageUrl(artifacts, "gloopies-22"),
  });
  const gloopyMedia = useAvatarMedia("app-avatar:gloopies-22");
  const start = useWidgetActivationGuard(shouldIgnoreActivation, () => {
    onStartOnboardingTour?.(() => {
      onUpdateState({ welcomeDismissed: true });
    });
  });
  const activateBerdy = useWidgetActivationGuard(shouldIgnoreActivation, () => {
    if (!welcomeDismissed || isResolvingBerdy) return;
    if (berdyPersonaId) {
      (onTagAgentInComposer ?? onOpenAgent)?.(berdyPersonaId);
      return;
    }
    if (!onResolveBerdyAgent) return;

    const attempt = ++resolveAttemptRef.current;
    setIsResolvingBerdy(true);
    void onResolveBerdyAgent()
      .then((resolvedPersonaId) => {
        if (!mountedRef.current || resolveAttemptRef.current !== attempt)
          return;
        if (resolvedPersonaId) {
          (onTagAgentInComposer ?? onOpenAgent)?.(resolvedPersonaId);
        }
      })
      .catch((error: unknown) => {
        console.error("Failed to resolve the bundled Berdy agent:", error);
      })
      .finally(() => {
        if (mountedRef.current && resolveAttemptRef.current === attempt) {
          setIsResolvingBerdy(false);
        }
      });
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      resolveAttemptRef.current += 1;
    };
  }, []);

  useLayoutEffect(() => {
    if (!welcomeDismissed) {
      resolveAttemptRef.current += 1;
      setIsResolvingBerdy(false);
      setIsBubbleSettled(false);
    }
  }, [welcomeDismissed]);

  return (
    <div className="pointer-events-none relative flex h-full w-full items-center">
      <div className="group relative size-40 shrink-0">
        <button
          type="button"
          data-onboarding-tour-avatar=""
          className="pointer-events-auto relative z-10 size-full cursor-pointer overflow-visible border-0 bg-transparent p-0 drop-shadow-[0_12px_12px_rgba(0,0,0,0.05)] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
          aria-label={t("onboarding.callout.openHelp")}
          disabled={
            !welcomeDismissed ||
            personasLoading ||
            isResolvingBerdy ||
            (!berdyPersonaId && !onResolveBerdyAgent)
          }
          onClick={activateBerdy}
        >
          {gloopyMedia ? (
            <AvatarMedia
              media={gloopyMedia}
              poster={gloopyPoster.data}
              alt={t("onboarding.callout.avatarAlt")}
              loadingStrategy="eager"
              playbackMode="occasional"
              className="size-full object-contain"
            />
          ) : gloopyPoster.data ? (
            <img
              src={gloopyPoster.data}
              alt={t("onboarding.callout.avatarAlt")}
              className="size-full object-contain"
            />
          ) : (
            <div className="size-full rounded-full bg-accent/60" />
          )}
        </button>
        <span
          aria-hidden="true"
          data-testid="onboarding-tour-hover-label"
          className={cn(
            "pointer-events-none absolute top-full left-1/2 z-10 mt-1 max-w-[calc(100%-1.5rem)] -translate-x-1/2 truncate whitespace-nowrap rounded-full bg-card/90 px-2.5 py-1 text-xs font-medium text-foreground backdrop-blur-md transition-opacity duration-150",
            alwaysShowLabel
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
          )}
        >
          {t("onboarding.callout.avatarLabel")}
        </span>
      </div>
      <AnimatePresence initial={!welcomeDismissed}>
        {!welcomeDismissed ? (
          <motion.div
            key="welcome"
            data-onboarding-tour-bubble=""
            className="pointer-events-auto absolute bottom-24 left-36 w-72 text-sm text-card-foreground"
            initial={false}
            animate={{ opacity: 1 }}
            exit={shouldReduceMotion ? undefined : { opacity: 0, scale: 0.96 }}
            transition={{
              duration: shouldReduceMotion ? 0 : 0.28,
              ease: [0.22, 1, 0.36, 1],
            }}
            style={{
              x: swayX,
              y: swayY,
              rotate: swayRotate,
              transformOrigin: "52px calc(100% + 8px)",
              willChange: shouldReduceMotion ? "auto" : "transform",
            }}
          >
            <div
              aria-hidden="true"
              data-onboarding-tour-bubble-flow=""
              className="onboarding-tour-bubble-flow absolute inset-0"
            >
              <motion.svg
                aria-hidden="true"
                data-onboarding-tour-liquid-shadow=""
                viewBox="0 0 288 112"
                preserveAspectRatio="none"
                className="absolute inset-0 size-full overflow-visible"
                initial={shouldReduceMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{
                  delay: shouldReduceMotion ? 0 : 0.72,
                  duration: shouldReduceMotion ? 0 : 0.2,
                  ease: [0.16, 1, 0.3, 1],
                }}
              >
                <defs>
                  <filter
                    id={bubbleShadowId}
                    x="-30%"
                    y="-30%"
                    width="160%"
                    height="190%"
                    colorInterpolationFilters="sRGB"
                  >
                    <feGaussianBlur
                      in="SourceAlpha"
                      stdDeviation="9"
                      result="blur"
                    />
                    <feOffset in="blur" dx="0" dy="12" result="offsetBlur" />
                    <feFlood
                      floodColor="rgb(0 0 0)"
                      floodOpacity="0.14"
                      result="shadowColor"
                    />
                    <feComposite
                      in="shadowColor"
                      in2="offsetBlur"
                      operator="in"
                    />
                  </filter>
                </defs>
                <path
                  className="fill-card dark:fill-secondary"
                  d={SETTLED_BUBBLE_PATH}
                  filter={`url(#${bubbleShadowId})`}
                />
              </motion.svg>
              <motion.svg
                data-onboarding-tour-liquid=""
                viewBox="0 0 288 112"
                preserveAspectRatio="none"
                className="absolute inset-0 size-full origin-bottom-left overflow-visible"
                initial={
                  shouldReduceMotion
                    ? false
                    : { opacity: 0, scaleX: 0.04, scaleY: 0.04 }
                }
                animate={{ opacity: 1, scaleX: 1, scaleY: 1 }}
                transition={{
                  delay: shouldReduceMotion ? 0 : 0.38,
                  duration: shouldReduceMotion ? 0 : 0.62,
                  ease: [0.16, 1, 0.3, 1],
                }}
                onAnimationComplete={() => setIsBubbleSettled(true)}
              >
                <path
                  className="fill-card dark:fill-secondary"
                  d={SETTLED_BUBBLE_PATH}
                />
              </motion.svg>
              <motion.div
                data-onboarding-tour-caret-dot="small"
                className="absolute -bottom-9 left-1 size-3 origin-top rounded-full bg-card dark:bg-secondary"
                initial={
                  shouldReduceMotion
                    ? false
                    : { opacity: 0, scale: 0, x: 6, y: 4 }
                }
                animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
                transition={
                  shouldReduceMotion
                    ? { duration: 0 }
                    : {
                        type: "tween",
                        duration: 0.28,
                        delay: 0,
                        ease: [0.16, 1, 0.3, 1],
                      }
                }
              />
              <motion.div
                data-onboarding-tour-caret-dot="large"
                className="absolute -bottom-4 left-4 size-8 origin-top rounded-full bg-card dark:bg-secondary"
                initial={
                  shouldReduceMotion ? false : { opacity: 0, scale: 0, x: -5 }
                }
                animate={{ opacity: 1, scale: 1, x: 0 }}
                transition={
                  shouldReduceMotion
                    ? { duration: 0 }
                    : {
                        type: "tween",
                        duration: 0.34,
                        delay: 0.16,
                        ease: [0.16, 1, 0.3, 1],
                      }
                }
              >
                <span
                  data-onboarding-tour-connector-fillet="top"
                  className="absolute top-2 -left-0.5 size-2 rounded-full bg-card dark:bg-secondary"
                />
                <span
                  data-onboarding-tour-connector-fillet="bottom"
                  className="absolute top-2 -right-0.5 size-2 rounded-full bg-card dark:bg-secondary"
                />
              </motion.div>
            </div>
            <motion.div
              className="onboarding-tour-bubble-content relative z-10 rounded-2xl p-5"
              inert={!shouldReduceMotion && !isBubbleSettled ? true : undefined}
              initial={false}
              animate={{
                opacity: shouldReduceMotion || isBubbleSettled ? 1 : 0,
              }}
              transition={{
                duration: shouldReduceMotion ? 0 : 0.34,
                ease: "easeOut",
              }}
            >
              <p className="pr-5 font-medium leading-5">
                {t("onboarding.callout.title")}
              </p>
              <p className="mb-4 leading-5">{t("onboarding.callout.body")}</p>
              <Button
                type="button"
                variant="subtle"
                size="sm"
                className="text-sm shadow-none drop-shadow-none dark:bg-sidebar-accent dark:text-sidebar-accent-foreground dark:hover:bg-sidebar-accent"
                onClick={start}
              >
                {t("onboarding.callout.action")}
              </Button>
            </motion.div>
            <motion.div
              className="absolute right-3 top-2.5 z-20"
              inert={!shouldReduceMotion && !isBubbleSettled ? true : undefined}
              initial={false}
              animate={{
                opacity: shouldReduceMotion || isBubbleSettled ? 1 : 0,
              }}
              transition={{
                duration: shouldReduceMotion ? 0 : 0.34,
                ease: "easeOut",
              }}
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t("onboarding.callout.dismiss")}
                onClick={(event) => {
                  event.stopPropagation();
                  onUpdateState({ welcomeDismissed: true });
                }}
              >
                <X />
              </Button>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
});
