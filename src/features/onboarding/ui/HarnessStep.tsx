import { IconCheck } from "@tabler/icons-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import { getProviderIcon } from "@/shared/ui/icons/ProviderIcons";
import { CURATED_PROVIDER_CATALOG_BY_ID } from "@/features/providers/curatedProviders";
import { CURATED_HARNESS_IDS, type CuratedHarnessId } from "../model";
import { OnboardingShell } from "./OnboardingShell";

const PROVIDER_ICON_SIZES: Record<CuratedHarnessId, string> = {
  goose: "size-[100px]",
  "claude-acp": "size-[92px]",
  "codex-acp": "size-[94px]",
  "copilot-acp": "size-[100px]",
  "amp-acp": "size-[92px]",
  "cursor-agent": "size-[90px]",
  "pi-acp": "size-[92px]",
};

interface HarnessStepProps {
  selectedId: string | null;
  onSelect: (id: CuratedHarnessId) => void;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
}

export function HarnessStep({
  selectedId,
  onSelect,
  onBack,
  onNext,
  onSkip,
}: HarnessStepProps) {
  const reduceMotion = useReducedMotion();
  const { t } = useTranslation("onboarding");
  const selectedProvider = selectedId
    ? CURATED_PROVIDER_CATALOG_BY_ID.get(selectedId)
    : undefined;
  const primaryLabel =
    selectedProvider?.setupMethod === "none"
      ? t("harness.finish")
      : t("harness.install");
  const selectRelativeProvider = (
    currentId: CuratedHarnessId,
    offset: number,
  ) => {
    const currentIndex = CURATED_HARNESS_IDS.indexOf(currentId);
    const nextIndex =
      (currentIndex + offset + CURATED_HARNESS_IDS.length) %
      CURATED_HARNESS_IDS.length;
    const nextId = CURATED_HARNESS_IDS[nextIndex];
    onSelect(nextId);
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-provider-id="${nextId}"]`)
        ?.focus();
    });
  };
  return (
    <OnboardingShell
      onBack={onBack}
      title={t("harness.title")}
      description={t("harness.description")}
      actions={
        <>
          <Button type="button" onClick={onNext} disabled={!selectedId}>
            {primaryLabel}
          </Button>
          <Button type="button" variant="outline" onClick={onSkip}>
            {t("harness.skip")}
          </Button>
        </>
      }
    >
      <div className="w-full overflow-x-auto">
        <div
          role="radiogroup"
          aria-label={t("harness.providerGroup")}
          className="mx-auto flex w-max min-w-full shrink-0 justify-around gap-8 px-8"
        >
          {CURATED_HARNESS_IDS.map((id, index) => {
            const provider = CURATED_PROVIDER_CATALOG_BY_ID.get(id);
            if (!provider) return null;
            const selected = selectedId === id;
            const muted = selectedId !== null && !selected;
            return (
              <motion.button
                key={id}
                data-provider-id={id}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={
                  selected || (selectedId === null && index === 0) ? 0 : -1
                }
                onClick={() => onSelect(id)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                    event.preventDefault();
                    selectRelativeProvider(id, 1);
                  } else if (
                    event.key === "ArrowLeft" ||
                    event.key === "ArrowUp"
                  ) {
                    event.preventDefault();
                    selectRelativeProvider(id, -1);
                  }
                }}
                initial={reduceMotion ? false : { opacity: 0, y: 18 }}
                animate={{ opacity: muted ? 0.45 : 1, y: 0 }}
                transition={{
                  duration: reduceMotion ? 0 : 0.3,
                  delay: reduceMotion || selectedId !== null ? 0 : index * 0.08,
                }}
                className="flex w-[130px] flex-col items-center gap-5 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-4"
              >
                <motion.span
                  animate={{ scale: selected ? 1.1 : 1 }}
                  transition={
                    reduceMotion
                      ? { duration: 0 }
                      : { type: "spring", stiffness: 360, damping: 24 }
                  }
                  className="flex size-[108px] items-center justify-center"
                >
                  {getProviderIcon(id, PROVIDER_ICON_SIZES[id])}
                </motion.span>
                <span className="flex h-9 min-w-[88px] items-center justify-center gap-1.5 rounded-full bg-card px-3 text-sm">
                  <AnimatePresence initial={false}>
                    {selected ? (
                      <motion.span
                        key="selected-check"
                        initial={
                          reduceMotion
                            ? false
                            : { opacity: 0, scale: 0.5, width: 0 }
                        }
                        animate={{ opacity: 1, scale: 1, width: 14 }}
                        exit={{ opacity: 0, scale: 0.5, width: 0 }}
                        transition={{
                          duration: reduceMotion ? 0 : 0.18,
                          ease: "easeOut",
                        }}
                        className="inline-flex shrink-0 items-center justify-center overflow-hidden"
                      >
                        <IconCheck
                          aria-hidden="true"
                          className="size-3.5 text-foreground"
                        />
                      </motion.span>
                    ) : null}
                  </AnimatePresence>
                  {provider.displayName.replace(" Agent", "")}
                </span>
              </motion.button>
            );
          })}
        </div>
      </div>
    </OnboardingShell>
  );
}
