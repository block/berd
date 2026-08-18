import { useEffect, useId, useRef, useState, type PointerEvent } from "react";
import { motion, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import { ProjectArtifactPreview } from "@/features/projects/artifact/ProjectArtifactPreview";
import type { ProjectArtifactMotionImpulse } from "@/features/projects/artifact/types";
import { UsageDataDialog } from "@/features/settings/ui/UsageDataDialog";
import { useProfileCapability } from "@/shared/profile/capabilities";
import {
  telemetryConsentEnforced,
  updateTelemetryEnabled,
} from "@/shared/telemetry/consent";
import { OnboardingShell } from "./OnboardingShell";

interface WelcomeStepProps {
  onStart: () => void;
  // The answer recorded by a previous completion of the welcome ceremony,
  // null when the user has never advanced past this page. The page never
  // reads the telemetry-enabled setting itself — it only writes it.
  recordedShareUsageData: boolean | null;
  onRecordShareUsageData: (shareUsageData: boolean) => void;
}

const reveal = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0 },
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function WelcomeStep({
  onStart,
  recordedShareUsageData,
  onRecordShareUsageData,
}: WelcomeStepProps) {
  const { t } = useTranslation("onboarding");
  const reduceMotion = useReducedMotion() === true;
  const checkboxId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  // The landing page is the one consent surface that defaults to sharing ON:
  // the persisted Rust-owned setting stays at its opt-in default (OFF) until
  // the user advances, so declining is just leaving the page. A per-visit
  // toggle layers over the recorded answer so Back navigation shows what was
  // actually chosen instead of resetting to the default.
  const [visitAnswer, setVisitAnswer] = useState<boolean | null>(null);
  const shareUsageData = visitAnswer ?? recordedShareUsageData ?? true;
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Mirrors TelemetryConsentRow's gate: enforced builds decide consent as
  // build policy, and capability-less sessions can never emit an event, so in
  // both cases asking would be noise. Hiding also skips the write on start,
  // leaving the persisted choice untouched.
  const consentAvailable = useProfileCapability("telemetry");
  const consentHidden = telemetryConsentEnforced() || !consentAvailable;
  const [cubeMotion, setCubeMotion] = useState<ProjectArtifactMotionImpulse>();
  const lastPointer = useRef<{ x: number; y: number; time: number } | null>(
    null,
  );

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const updateCubeMotion = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const current = {
      x: event.clientX,
      y: event.clientY,
      time: event.timeStamp,
    };
    const previous = lastPointer.current;
    lastPointer.current = current;
    const hoverX = clamp(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -1,
      1,
    );
    const hoverY = clamp(
      -(((event.clientY - rect.top) / rect.height) * 2 - 1),
      -1,
      1,
    );
    const elapsed = Math.max(
      current.time - (previous?.time ?? current.time),
      8,
    );
    const deltaX = previous ? (current.x - previous.x) / rect.width : 0;
    const deltaY = previous ? (current.y - previous.y) / rect.height : 0;
    const velocityBoost = clamp(
      1 + (Math.hypot(deltaX, deltaY) / (elapsed / 1000)) * 0.22,
      0.9,
      3.1,
    );
    setCubeMotion((motion) => ({
      sequence: (motion?.sequence ?? 0) + 1,
      deltaX: clamp(deltaX * velocityBoost, -0.3, 0.3),
      deltaY: clamp(deltaY * velocityBoost, -0.3, 0.3),
      hoverX: Math.abs(hoverX) < 0.08 ? 0.22 : hoverX,
      hoverY: Math.abs(hoverY) < 0.08 ? 0.16 : hoverY,
    }));
  };

  const resetCubeMotion = () => {
    lastPointer.current = null;
    setCubeMotion((motion) =>
      motion
        ? {
            ...motion,
            sequence: motion.sequence + 1,
            deltaX: 0,
            deltaY: 0,
            hoverX: 0,
            hoverY: 0,
          }
        : motion,
    );
  };

  return (
    <OnboardingShell contentClassName="max-[760px]:overflow-x-hidden max-[760px]:overflow-y-auto">
      <motion.div
        className="relative grid h-full w-full grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)] items-center gap-[clamp(3rem,8vw,10rem)] px-[clamp(0rem,4vw,5rem)] pt-[var(--spacing-app-top-bar)] max-[760px]:grid-cols-1 max-[760px]:gap-0 max-[760px]:px-8"
        initial="hidden"
        animate="visible"
        transition={{ staggerChildren: reduceMotion ? 0 : 0.12 }}
      >
        <motion.div
          variants={reveal}
          transition={{ duration: reduceMotion ? 0 : 0.35 }}
          className="flex h-[min(92vh,980px)] w-[min(62vw,980px)] translate-x-16 items-center justify-self-end overflow-visible max-[760px]:absolute max-[760px]:bottom-[calc(-18vh-80px)] max-[760px]:left-1/2 max-[760px]:h-[62vh] max-[760px]:w-full max-[760px]:-translate-x-1/2 max-[760px]:justify-center"
          aria-hidden="true"
          onPointerEnter={reduceMotion ? undefined : updateCubeMotion}
          onPointerMove={reduceMotion ? undefined : updateCubeMotion}
          onPointerLeave={reduceMotion ? undefined : resetCubeMotion}
        >
          <div className="h-[120%] w-[120%] shrink-0 -translate-x-64 scale-[1.0875] max-[760px]:h-[145%] max-[760px]:w-[145%] max-[760px]:translate-x-0 max-[760px]:translate-y-12 max-[760px]:scale-[1.15]">
            <ProjectArtifactPreview
              input={{
                projectId: "berd-welcome",
                name: "Welcome to Berd",
                color: "olive",
                artifact: {
                  seed: 18,
                  color: "olive",
                  mood: "serene",
                  moodIntensity: 0.72,
                  contentMode: "cube",
                },
              }}
              variant="tile"
              cameraDistanceScale={1.2}
              motionImpulse={reduceMotion ? undefined : cubeMotion}
              gestureFreezeActive={reduceMotion}
              className="h-full w-full"
            />
          </div>
        </motion.div>

        <motion.section
          variants={reveal}
          transition={{ duration: reduceMotion ? 0 : 0.35 }}
          className="w-full max-w-[390px] justify-self-start max-[760px]:absolute max-[760px]:top-[42%] max-[760px]:left-1/2 max-[760px]:-translate-x-1/2 max-[760px]:-translate-y-1/2 max-[760px]:text-center"
        >
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-[clamp(2.25rem,3.2vw,3.5rem)] leading-[0.98] font-normal tracking-[-0.045em] text-foreground outline-none"
          >
            {t("welcome.title")}
            <br />
            {t("welcome.subtitle")}
          </h1>

          <Button
            type="button"
            size="lg"
            className="mt-9 w-[calc(100%-80px)] max-[760px]:mx-auto"
            onClick={() => {
              // Fire-and-forget: the landing page advances regardless of
              // whether the native write lands. A failed write fails closed —
              // the Rust-owned setting keeps its OFF default, so nothing is
              // sent — and the Settings toggle remains the repair path. No
              // explicit pipeline start either: telemetry initialized at boot,
              // and the consent store update brings the pipeline up.
              if (!consentHidden) {
                onRecordShareUsageData(shareUsageData);
                // Sharing ON is written only when it is news — the first
                // completion of the ceremony (the default-ON landing consent)
                // or a deliberate change on a revisit — so a stale checkbox
                // passed through untouched can never overwrite a later
                // Settings opt-out. Sharing OFF is always re-asserted: the
                // user is advancing past a visibly unchecked box, and writing
                // OFF can only ever stop data from being sent.
                if (!shareUsageData || recordedShareUsageData !== true) {
                  updateTelemetryEnabled(shareUsageData).catch((error) => {
                    console.warn(
                      "Failed to persist the usage-data choice:",
                      error,
                    );
                  });
                }
              }
              onStart();
            }}
          >
            {t("welcome.getStarted")}
          </Button>

          {consentHidden ? null : (
            <div className="mt-6 flex w-[calc(100%-72px)] items-start gap-2.5 text-left text-xs leading-[1.15] text-muted-foreground max-[760px]:mx-auto">
              <Checkbox
                id={checkboxId}
                checked={shareUsageData}
                onCheckedChange={(checked) => setVisitAnswer(checked === true)}
                aria-describedby={`${checkboxId}-description`}
              />
              <p id={`${checkboxId}-description`}>
                <label htmlFor={checkboxId}>{t("welcome.usageConsent")}</label>{" "}
                <Button
                  type="button"
                  variant="link"
                  className="text-xs"
                  onClick={() => setDetailsOpen(true)}
                >
                  {t("welcome.learnMore")}
                </Button>
              </p>
            </div>
          )}
        </motion.section>
      </motion.div>

      <UsageDataDialog open={detailsOpen} onOpenChange={setDetailsOpen} />
    </OnboardingShell>
  );
}
