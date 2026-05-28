import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useReducedMotion } from "motion/react";

import gooseStartupLoadingMp4 from "@/app/assets/goose-startup-loading.mp4";
import gooseStartupLoadingWebm from "@/app/assets/goose-startup-loading.webm";
import { Spinner } from "@/shared/ui/spinner";

export function StartupLoadingView() {
  const { t } = useTranslation("common");
  const shouldReduceMotion = useReducedMotion();
  const [videoFailed, setVideoFailed] = useState(false);

  return (
    <div
      className="flex h-screen w-screen items-center justify-center bg-background text-foreground"
      role="status"
      aria-label={t("startup.loadingLabel")}
    >
      {shouldReduceMotion || videoFailed ? (
        <Spinner decorative className="size-5 text-primary" />
      ) : (
        <video
          className="size-16 text-primary"
          autoPlay
          loop
          muted
          playsInline
          preload="auto"
          onError={() => setVideoFailed(true)}
        >
          <source src={gooseStartupLoadingMp4} type="video/mp4" />
          <source src={gooseStartupLoadingWebm} type="video/webm" />
        </video>
      )}
    </div>
  );
}
