import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, ChevronLeft, X } from "lucide-react";
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
} from "motion/react";
import { selectAvatarImageUrl } from "@/shared/api/artifacts";
import { useHomePinLabelsPreference } from "@/features/home/lib/homePinLabelPreference";
import { useArtifacts } from "@/shared/hooks/useArtifacts";
import { useAvatarMedia } from "@/shared/hooks/useAvatarSrc";
import { cn } from "@/shared/lib/cn";
import { AvatarMedia } from "@/shared/ui/avatar-media";
import { Button } from "@/shared/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/shared/ui/input-group";
import type { WidgetRenderProps } from "./types";
import { useWidgetActivationGuard } from "./useWidgetActivationGuard";

const SETTLED_BUBBLE_PATH =
  "M 16 0 C 7 0 0 4 0 8 C 0 40 0 72 0 104 C 0 108 7 112 16 112 C 90 112 198 112 272 112 C 281 112 288 108 288 104 C 288 72 288 40 288 8 C 288 4 281 0 272 0 C 196 0 91 0 16 0 Z";

const SWAY_X_SPRING = { stiffness: 110, damping: 12, mass: 0.85 };
const SWAY_Y_SPRING = { stiffness: 190, damping: 24, mass: 0.7 };
const SWAY_ROTATION_SPRING = { stiffness: 140, damping: 16, mass: 0.7 };

const HELP_PRESET_KEYS = ["useCases", "projects", "agentsAndSkills"] as const;
type HelpPresetKey = (typeof HELP_PRESET_KEYS)[number];

function OnboardingBackButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-onboarding-tour-back=""
      className="flex items-center gap-1 pr-5 font-medium leading-5 text-muted-foreground transition-colors hover:text-foreground"
      onClick={onClick}
    >
      <ChevronLeft className="size-3.5" aria-hidden="true" />
      {label}
    </button>
  );
}

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

export function OnboardingTourWidget({
  instance,
  onUpdateState,
  shouldIgnoreActivation,
  onStartOnboardingTour,
  onStartChatWithPrompt,
  canvasDragPosition,
}: WidgetRenderProps) {
  const { t } = useTranslation("home");
  const { enabled: alwaysShowLabel } = useHomePinLabelsPreference();
  const shouldReduceMotion = useReducedMotion();
  const bubbleShadowId = `berdy-bubble-shadow-${useId().replace(/:/g, "")}`;
  const [isBubbleSettled, setIsBubbleSettled] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [activePreset, setActivePreset] = useState<HelpPresetKey | null>(null);
  const [prompt, setPrompt] = useState("");
  const [isStartingChat, setIsStartingChat] = useState(false);
  const startChatInFlightRef = useRef(false);
  const welcomeDismissed = instance.state?.welcomeDismissed === true;
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
  const gloopyPoster = useArtifacts({
    select: (artifacts) => selectAvatarImageUrl(artifacts, "gloopies-14"),
  });
  const gloopyMedia = useAvatarMedia("app-avatar:gloopies-14");
  const start = useWidgetActivationGuard(shouldIgnoreActivation, () => {
    onStartOnboardingTour?.();
  });
  const toggleHelp = useWidgetActivationGuard(shouldIgnoreActivation, () => {
    if (welcomeDismissed) {
      if (helpOpen) {
        setHelpOpen(false);
        setPrompt("");
        setComposerOpen(false);
        setActivePreset(null);
        return;
      }
      setIsBubbleSettled(false);
      setPrompt("");
      setComposerOpen(false);
      setActivePreset(null);
      setHelpOpen(true);
    }
  });

  const startChat = async (text: string) => {
    if (!onStartChatWithPrompt || startChatInFlightRef.current) {
      return;
    }
    startChatInFlightRef.current = true;
    setIsStartingChat(true);
    try {
      const didStart = await onStartChatWithPrompt(text);
      if (didStart === false) {
        return;
      }
      setPrompt("");
      setComposerOpen(false);
      setActivePreset(null);
      setHelpOpen(false);
    } finally {
      startChatInFlightRef.current = false;
      setIsStartingChat(false);
    }
  };

  const showPresetResponse = (key: HelpPresetKey) => {
    setPrompt("");
    setComposerOpen(false);
    setActivePreset(key);
  };

  const returnToSuggestions = () => {
    setPrompt("");
    setComposerOpen(false);
    setActivePreset(null);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const text = prompt.trim();
    if (!text) {
      return;
    }
    void startChat(text);
  };

  const handlePresetFollowUp = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const followUp = prompt.trim();
    if (!activePreset || !followUp) {
      return;
    }

    void startChat(
      t("onboarding.callout.followUpContext", {
        question: t(`onboarding.callout.presets.${activePreset}`),
        followUp,
      }),
    );
  };
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
    if (!lastPosition) {
      return;
    }

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

    // The bubble trails behind Berdy's direction of travel, like a mass held
    // by the speech-bubble caret, then preserves that velocity in the spring.
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

  return (
    <div className="pointer-events-none relative flex h-full w-full items-center">
      <div className="group relative size-40 shrink-0">
        <button
          type="button"
          data-onboarding-tour-avatar=""
          className="pointer-events-auto relative z-10 size-full cursor-pointer overflow-visible border-0 bg-transparent p-0 drop-shadow-[0_12px_12px_rgba(0,0,0,0.05)] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
          aria-label={t("onboarding.callout.openHelp")}
          disabled={!welcomeDismissed}
          onClick={toggleHelp}
        >
          {gloopyMedia ? (
            <AvatarMedia
              media={gloopyMedia}
              poster={gloopyPoster.data}
              alt={t("onboarding.callout.avatarAlt")}
              loadingStrategy="lazy-once"
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
        {!welcomeDismissed || helpOpen ? (
          <motion.div
            key={welcomeDismissed ? "help" : "welcome"}
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
                  className="fill-card dark:fill-sidebar-navigation-panel-bg"
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
                  className="fill-card dark:fill-sidebar-navigation-panel-bg"
                  d={SETTLED_BUBBLE_PATH}
                />
              </motion.svg>
              <motion.div
                data-onboarding-tour-caret-dot="small"
                className="absolute -bottom-9 left-1 size-3 origin-top rounded-full bg-card dark:bg-sidebar-navigation-panel-bg"
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
                className="absolute -bottom-4 left-4 size-8 origin-top rounded-full bg-card dark:bg-sidebar-navigation-panel-bg"
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
                  className="absolute top-2 -left-0.5 size-2 rounded-full bg-card dark:bg-sidebar-navigation-panel-bg"
                />
                <span
                  data-onboarding-tour-connector-fillet="bottom"
                  className="absolute top-2 -right-0.5 size-2 rounded-full bg-card dark:bg-sidebar-navigation-panel-bg"
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
              {welcomeDismissed ? (
                <div className="space-y-3">
                  {activePreset || composerOpen ? (
                    <OnboardingBackButton
                      label={t("onboarding.callout.back")}
                      onClick={returnToSuggestions}
                    />
                  ) : (
                    <p className="pr-5 font-medium leading-5">
                      {t("onboarding.callout.helpTitle")}
                    </p>
                  )}
                  <AnimatePresence mode="wait" initial={false}>
                    {composerOpen ? (
                      <motion.form
                        key="composer"
                        className="space-y-2"
                        initial={
                          shouldReduceMotion ? false : { opacity: 0, x: 6 }
                        }
                        animate={{ opacity: 1, x: 0 }}
                        exit={
                          shouldReduceMotion ? undefined : { opacity: 0, x: 6 }
                        }
                        transition={{ duration: shouldReduceMotion ? 0 : 0.16 }}
                        onSubmit={handleSubmit}
                      >
                        <InputGroup className="border-transparent bg-muted/40 shadow-none focus-within:!border-transparent dark:bg-muted/40">
                          <InputGroupInput
                            value={prompt}
                            onChange={(event) => setPrompt(event.target.value)}
                            placeholder={t(
                              "onboarding.callout.helpPlaceholder",
                            )}
                            aria-label={t("onboarding.callout.helpPlaceholder")}
                            autoFocus
                          />
                          <InputGroupAddon
                            align="inline-end"
                            className="ml-auto"
                          >
                            <InputGroupButton
                              type="submit"
                              size="icon-sm"
                              variant="ghost"
                              disabled={
                                !prompt.trim() ||
                                !onStartChatWithPrompt ||
                                isStartingChat
                              }
                              aria-label={t("onboarding.callout.send")}
                            >
                              <ArrowRight className="size-4" />
                            </InputGroupButton>
                          </InputGroupAddon>
                        </InputGroup>
                      </motion.form>
                    ) : activePreset ? (
                      <motion.div
                        key={`preset-${activePreset}`}
                        className="space-y-2.5"
                        initial={
                          shouldReduceMotion ? false : { opacity: 0, x: -6 }
                        }
                        animate={{ opacity: 1, x: 0 }}
                        exit={
                          shouldReduceMotion ? undefined : { opacity: 0, x: -6 }
                        }
                        transition={{ duration: shouldReduceMotion ? 0 : 0.16 }}
                      >
                        <div
                          data-onboarding-tour-response=""
                          className="space-y-2.5"
                        >
                          <p className="text-sm leading-5">
                            {t(
                              `onboarding.callout.presetResponses.${activePreset}`,
                            )}
                          </p>
                          <form onSubmit={handlePresetFollowUp}>
                            <InputGroup className="border-transparent bg-muted/40 shadow-none focus-within:!border-transparent dark:bg-muted/40">
                              <InputGroupInput
                                value={prompt}
                                onChange={(event) =>
                                  setPrompt(event.target.value)
                                }
                                placeholder={t(
                                  "onboarding.callout.followUpPlaceholder",
                                )}
                                aria-label={t(
                                  "onboarding.callout.followUpPlaceholder",
                                )}
                              />
                              <InputGroupAddon
                                align="inline-end"
                                className="ml-auto"
                              >
                                <InputGroupButton
                                  type="submit"
                                  size="icon-sm"
                                  variant="ghost"
                                  disabled={
                                    !prompt.trim() ||
                                    !onStartChatWithPrompt ||
                                    isStartingChat
                                  }
                                  aria-label={t(
                                    "onboarding.callout.sendFollowUp",
                                  )}
                                >
                                  <ArrowRight className="size-4" />
                                </InputGroupButton>
                              </InputGroupAddon>
                            </InputGroup>
                          </form>
                        </div>
                      </motion.div>
                    ) : (
                      <motion.div
                        key="suggestions"
                        className="space-y-2"
                        initial={
                          shouldReduceMotion ? false : { opacity: 0, x: -6 }
                        }
                        animate={{ opacity: 1, x: 0 }}
                        exit={
                          shouldReduceMotion ? undefined : { opacity: 0, x: -6 }
                        }
                        transition={{ duration: shouldReduceMotion ? 0 : 0.16 }}
                      >
                        {HELP_PRESET_KEYS.map((key) => {
                          const question = t(
                            `onboarding.callout.presets.${key}`,
                          );
                          return (
                            <button
                              key={key}
                              type="button"
                              className="group flex w-full items-center justify-between gap-2 bg-transparent px-0 py-1.5 text-left text-sm leading-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              onClick={() => showPresetResponse(key)}
                            >
                              <span className="transition-[font-weight] duration-150 group-hover:font-medium group-focus-visible:font-medium motion-reduce:transition-none">
                                {question}
                              </span>
                              <ArrowRight
                                className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
                                aria-hidden="true"
                              />
                            </button>
                          );
                        })}
                        <button
                          type="button"
                          className="group flex w-full items-center justify-between gap-2 bg-transparent px-0 py-1.5 text-left text-sm leading-4 text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => setComposerOpen(true)}
                        >
                          <span className="transition-[font-weight] duration-150 group-hover:font-medium group-focus-visible:font-medium motion-reduce:transition-none">
                            {t("onboarding.callout.askSomethingElse")}
                          </span>
                          <ArrowRight
                            className="size-3 shrink-0 opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
                            aria-hidden="true"
                          />
                        </button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              ) : (
                <>
                  <p className="pr-5 font-medium leading-5">
                    {t("onboarding.callout.title")}
                  </p>
                  <p className="mb-4 leading-5">
                    {t("onboarding.callout.body")}
                  </p>
                  <Button
                    type="button"
                    variant="subtle"
                    size="sm"
                    className="text-sm shadow-none drop-shadow-none dark:bg-sidebar-accent dark:text-sidebar-accent-foreground dark:hover:bg-sidebar-accent"
                    onClick={start}
                  >
                    {t("onboarding.callout.action")}
                  </Button>
                </>
              )}
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
                aria-label={t(
                  welcomeDismissed
                    ? "onboarding.callout.closeHelp"
                    : "onboarding.callout.dismiss",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  if (welcomeDismissed) {
                    setComposerOpen(false);
                    setActivePreset(null);
                    setHelpOpen(false);
                  } else {
                    onUpdateState({ welcomeDismissed: true });
                  }
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
}
