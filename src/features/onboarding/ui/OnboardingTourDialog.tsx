import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import tourTexture from "../assets/texture.png";
import tourHomeImage from "../assets/tour-1.png";
import tourHomeDarkImage from "../assets/tour-1-dark.png";
import { ProjectArtifactPreview } from "@/features/projects/artifact/ProjectArtifactPreview";
import type {
  ProjectArtifactInput,
  ProjectArtifactMotionImpulse,
} from "@/features/projects/artifact/types";
import { Button } from "@/shared/ui/button";
import { useTheme } from "@/shared/theme/ThemeProvider";
import { GlassButton } from "@/shared/ui/glass-button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/shared/ui/dialog";
import {
  AmpIcon,
  ClaudeIcon,
  CodexIcon,
  GoogleGeminiIcon,
  OpenAIIcon,
} from "@/shared/ui/icons/ProviderIcons";

const TOUR_STEP_COUNT = 4;
const PROVIDER_EASE = [0.16, 1, 0.3, 1] as const;
const TOUR_PROJECT_BASE: Omit<ProjectArtifactInput, "name" | "prompt"> = {
  projectId: "onboarding-tour-project",
  color: "blue",
  workingDirs: ["project"],
  sessionCount: 6,
  artifact: {
    seed: 28,
    color: "blue",
    mood: "active",
    moodIntensity: 0.72,
    contentMode: "cubeStatic",
  },
};

interface OnboardingTourDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function OnboardingTourDialog({
  open,
  onOpenChange,
}: OnboardingTourDialogProps) {
  const { t } = useTranslation("home");
  const [step, setStep] = useState(0);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (open) setStep(0);
  }, [open]);

  useEffect(() => {
    if (open && titleRef.current?.dataset.onboardingTourStep === String(step)) {
      titleRef.current?.focus();
    }
  }, [open, step]);

  const advance = () => {
    if (step === TOUR_STEP_COUNT - 1) {
      onOpenChange(false);
      return;
    }
    setStep((current) => current + 1);
  };

  const goBack = () => {
    setStep((current) => Math.max(0, current - 1));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        surface="solid"
        showCloseButton={false}
        className="gap-0 overflow-hidden rounded-2xl p-0 dark:bg-card"
        overlayClassName="bg-[var(--overlay-onboarding-scrim)] [backdrop-filter:blur(18px)_saturate(90%)] [-webkit-backdrop-filter:blur(18px)_saturate(90%)]"
      >
        <DialogClose asChild>
          <GlassButton
            type="button"
            size="icon-sm"
            aria-label={t("onboarding.tour.close")}
            className="absolute right-3 top-3 z-30"
          >
            <X aria-hidden="true" />
          </GlassButton>
        </DialogClose>
        <TourArtwork step={step} onBack={goBack} onAdvance={advance} />
        <div
          data-onboarding-tour-copy=""
          className="relative min-h-36 bg-background px-6 py-5 dark:bg-card"
        >
          <p className="mb-2 text-xs text-muted-foreground">
            {t("onboarding.tour.progress", {
              current: step + 1,
              total: TOUR_STEP_COUNT,
            })}
          </p>
          <DialogTitle
            ref={titleRef}
            data-onboarding-tour-step={step}
            tabIndex={-1}
            className="mb-1.5 text-xl font-semibold leading-6 outline-none"
          >
            {t(`onboarding.tour.steps.${step + 1}.title`)}
          </DialogTitle>
          <DialogDescription className="max-w-[390px] leading-5 text-foreground">
            {t(`onboarding.tour.steps.${step + 1}.body`)}
          </DialogDescription>
          <Button
            type="button"
            size="sm"
            variant="subtle"
            className="mt-4 rounded-[10px] text-sm"
            onClick={advance}
          >
            {t(
              step === TOUR_STEP_COUNT - 1
                ? "onboarding.tour.doneAction"
                : "onboarding.tour.nextAction",
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface TourArtworkProps {
  step: number;
  onBack: () => void;
  onAdvance: () => void;
}

function TourArtwork({ step, onBack, onAdvance }: TourArtworkProps) {
  const { t } = useTranslation("home");

  return (
    <div
      data-onboarding-tour-background=""
      className="relative isolate h-[310px] overflow-hidden"
    >
      <img
        data-onboarding-tour-texture=""
        src={tourTexture}
        alt=""
        className="pointer-events-none absolute inset-0 size-full object-cover"
      />
      <div
        data-onboarding-tour-dark-inverter=""
        className="pointer-events-none absolute inset-0 hidden bg-white mix-blend-difference dark:block"
      />
      {step === 0 ? <CanvasPreview /> : null}
      {step === 1 ? <ChatPreview /> : null}
      {step === 2 ? <ProviderPreview /> : null}
      {step === 3 ? <ProjectPreview /> : null}
      <span className="sr-only">
        {t(`onboarding.tour.steps.${step + 1}.visual`)}
      </span>
      {step > 0 ? (
        <GlassButton
          type="button"
          size="icon-sm"
          onClick={onBack}
          aria-label={t("onboarding.tour.previous")}
          className="absolute left-3 top-1/2 z-20 -translate-y-1/2"
        >
          <ChevronLeft aria-hidden="true" />
        </GlassButton>
      ) : null}
      <GlassButton
        type="button"
        size="icon-sm"
        onClick={onAdvance}
        aria-label={
          step === TOUR_STEP_COUNT - 1
            ? t("onboarding.tour.finish")
            : t("onboarding.tour.next")
        }
        className="absolute right-3 top-1/2 z-20 -translate-y-1/2"
      >
        <ChevronRight aria-hidden="true" />
      </GlassButton>
    </div>
  );
}

function CanvasPreview() {
  const shouldReduceMotion = useReducedMotion();
  const { isDark } = useTheme();

  return (
    <div
      data-onboarding-tour-home-frame=""
      className="absolute inset-x-8 bottom-0 top-8 z-10 overflow-visible rounded-t-xl bg-canvas-base shadow-xl"
    >
      <motion.img
        data-onboarding-tour-home-image=""
        src={isDark ? tourHomeDarkImage : tourHomeImage}
        alt=""
        className="size-full object-contain object-right-top will-change-transform"
        initial={shouldReduceMotion ? false : { scale: 1 }}
        animate={{ scale: 1.45 }}
        transition={
          shouldReduceMotion
            ? { duration: 0 }
            : { delay: 0.05, duration: 0.75, ease: "easeInOut" }
        }
        style={{ transformOrigin: "100% 0%" }}
      />
    </div>
  );
}

function ChatPreview() {
  const { t } = useTranslation("home");
  const shouldReduceMotion = useReducedMotion();
  const [showResponse, setShowResponse] = useState(Boolean(shouldReduceMotion));

  useEffect(() => {
    if (shouldReduceMotion) {
      setShowResponse(true);
      return;
    }
    const timer = window.setTimeout(() => setShowResponse(true), 900);
    return () => window.clearTimeout(timer);
  }, [shouldReduceMotion]);

  return (
    <div className="relative z-10 h-full px-16 py-16 text-sm">
      <motion.div
        data-onboarding-tour-chat-bubble=""
        className="ml-auto w-fit max-w-[310px] rounded-2xl bg-background px-4 py-3 shadow-sm"
        initial={shouldReduceMotion ? false : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={
          shouldReduceMotion
            ? { duration: 0 }
            : { delay: 0.06, duration: 0.24, ease: "easeOut" }
        }
      >
        {t("onboarding.tour.chatPreview.prompt")}
      </motion.div>
      <motion.div
        layout={shouldReduceMotion ? false : "size"}
        data-onboarding-tour-chat-bubble=""
        className="mt-5 w-fit max-w-[310px] overflow-hidden rounded-2xl bg-background px-4 py-3 leading-5 shadow-sm"
        initial={shouldReduceMotion ? false : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          delay: shouldReduceMotion ? 0 : 0.25,
          duration: shouldReduceMotion ? 0 : 0.2,
          ease: "easeOut",
          layout: shouldReduceMotion
            ? { duration: 0 }
            : { type: "spring", mass: 0.85, stiffness: 190, damping: 22 },
        }}
      >
        <div className="grid">
          <AnimatePresence initial={false}>
            {showResponse ? (
              <motion.div
                key="response"
                className="col-start-1 row-start-1"
                initial={shouldReduceMotion ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: shouldReduceMotion ? 0 : 0.28,
                  ease: "easeOut",
                }}
              >
                {t("onboarding.tour.chatPreview.responseLine1")}
                <br />
                {t("onboarding.tour.chatPreview.responseLine2")}
                <br />
                {t("onboarding.tour.chatPreview.responseLine3")}
              </motion.div>
            ) : (
              <motion.div
                key="typing"
                aria-label={t("onboarding.tour.chatPreview.typing")}
                className="col-start-1 row-start-1 flex gap-1"
                exit={{ opacity: 0, y: -2 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
              >
                {[0, 1, 2].map((index) => (
                  <motion.span
                    key={index}
                    aria-hidden="true"
                    className="size-1.5 rounded-full bg-muted-foreground"
                    animate={{ opacity: [0.35, 1, 0.35], y: [0, -2, 0] }}
                    transition={{
                      duration: 0.72,
                      delay: index * 0.12,
                      repeat: Infinity,
                    }}
                  />
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}

function ProviderPreview() {
  const shouldReduceMotion = useReducedMotion();
  const providers = [
    { id: "openai", label: "OpenAI", Icon: OpenAIIcon },
    { id: "claude", label: "Claude", Icon: ClaudeIcon },
    { id: "codex", label: "Codex", Icon: CodexIcon },
    { id: "gemini", label: "Gemini", Icon: GoogleGeminiIcon },
    { id: "amp", label: "Amp", Icon: AmpIcon },
  ];
  return (
    <div className="absolute left-1/2 top-0 z-10 flex h-full w-max -translate-x-1/2 items-center gap-6">
      {providers.map(({ id, label, Icon }, index) => (
        <motion.div
          key={id}
          data-onboarding-tour-provider=""
          className="flex size-24 shrink-0 items-center justify-center rounded-2xl bg-background shadow-sm"
          initial={shouldReduceMotion ? false : { opacity: 0, x: -24 }}
          animate={{ opacity: 1, x: 0 }}
          transition={
            shouldReduceMotion
              ? { duration: 0 }
              : {
                  delay: 0.04 + index * 0.08,
                  duration: 0.34,
                  ease: PROVIDER_EASE,
                }
          }
        >
          <Icon className="size-12" />
          <span className="sr-only">{label}</span>
        </motion.div>
      ))}
    </div>
  );
}

function ProjectPreview() {
  const { t } = useTranslation("home");
  const shouldReduceMotion = useReducedMotion();
  const [motionImpulse, setMotionImpulse] =
    useState<ProjectArtifactMotionImpulse>();

  const animateProject = () => {
    if (shouldReduceMotion) return;
    setMotionImpulse((current) => ({
      sequence: (current?.sequence ?? 0) + 1,
      deltaX: 0.26,
      deltaY: -0.08,
    }));
  };

  return (
    <button
      type="button"
      onClick={animateProject}
      aria-label={t("onboarding.tour.animateProject")}
      className="relative z-10 mx-auto flex h-full w-[310px] cursor-pointer items-center justify-center bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <ProjectArtifactPreview
        input={{
          ...TOUR_PROJECT_BASE,
          name: t("onboarding.tour.projectPreview.name"),
          prompt: t("onboarding.tour.projectPreview.description"),
        }}
        className="scale-110"
        motionImpulse={motionImpulse}
        variant="tile"
      />
    </button>
  );
}
