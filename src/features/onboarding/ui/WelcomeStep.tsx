import { motion, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import { BerdIcon } from "@/shared/ui/icons/BerdIcon";
import { useArtifacts } from "@/shared/hooks/useArtifacts";
import { selectCollectionImageUrl } from "@/shared/api/artifacts";
import { OnboardingShell } from "./OnboardingShell";

interface WelcomeStepProps {
  onStart: () => void;
}

const reveal = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0 },
};

export function WelcomeStep({ onStart }: WelcomeStepProps) {
  const { t } = useTranslation("onboarding");
  const reduceMotion = useReducedMotion();
  const duration = reduceMotion ? 0 : 0.28;
  const { data: artifacts } = useArtifacts();
  const projectThumbnail = selectCollectionImageUrl(
    artifacts,
    "onboarding",
    "project-cube",
  );
  const avatarThumbnail = selectCollectionImageUrl(
    artifacts,
    "onboarding",
    "avatar-thumbnail",
  );

  return (
    <OnboardingShell>
      <motion.div
        className="flex h-full items-center justify-center px-8 pb-4"
        initial="hidden"
        animate="visible"
        transition={{ staggerChildren: reduceMotion ? 0 : 0.32 }}
      >
        <div className="text-center">
          <motion.h1
            variants={reveal}
            transition={{ duration }}
            className="text-[48px] leading-tight font-normal text-foreground"
          >
            {t("welcome.title")}
          </motion.h1>
          <div className="mt-3 text-[48px] leading-[1.28] text-muted-foreground">
            <motion.div variants={reveal} transition={{ duration }}>
              {t("welcome.projects")}{" "}
              {projectThumbnail ? (
                <img
                  src={projectThumbnail}
                  alt=""
                  className="inline h-[64px] w-auto object-contain align-middle"
                />
              ) : null}
              ,
            </motion.div>
            <motion.div variants={reveal} transition={{ duration }}>
              {t("welcome.agents")}{" "}
              {avatarThumbnail ? (
                <img
                  src={avatarThumbnail}
                  alt=""
                  className="inline h-[76px] w-auto object-contain align-middle"
                />
              ) : null}
              , {t("welcome.and")}
            </motion.div>
            <motion.div variants={reveal} transition={{ duration }}>
              {t("welcome.done")}{" "}
              <span className="inline-flex size-12 rotate-[-10deg] items-center justify-center rounded-[8px] bg-foreground align-middle text-background">
                <BerdIcon className="size-8" />
              </span>
            </motion.div>
          </div>
          <motion.div
            variants={reveal}
            transition={{ duration }}
            className="mt-7"
          >
            <Button type="button" className="w-[230px]" onClick={onStart}>
              {t("welcome.getStarted")}
            </Button>
          </motion.div>
        </div>
      </motion.div>
    </OnboardingShell>
  );
}
