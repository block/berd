import { useTranslation } from "react-i18next";
import { useReducedMotion } from "motion/react";

import startupLoadingGif from "@/app/assets/startup-loading.gif";
import startupLoadingPoster from "@/app/assets/startup-loading-poster.png";
import { STARTUP_LOADING_LOGO_SIZE_PX } from "@/app/lib/startupLoading";

const startupLoadingLogoStyle = {
  width: STARTUP_LOADING_LOGO_SIZE_PX,
  height: STARTUP_LOADING_LOGO_SIZE_PX,
} as const;

export function StartupLoadingView() {
  const { t } = useTranslation("common");
  const shouldReduceMotion = useReducedMotion();

  return (
    <div
      className="flex h-screen w-screen items-center justify-center bg-dot-grid text-foreground"
      role="status"
      aria-label={t("startup.loadingLabel")}
    >
      {shouldReduceMotion ? (
        <img
          src={startupLoadingPoster}
          alt=""
          aria-hidden
          className="pointer-events-none object-contain"
          style={startupLoadingLogoStyle}
          decoding="sync"
          fetchPriority="high"
        />
      ) : (
        <img
          src={startupLoadingGif}
          alt=""
          aria-hidden
          className="pointer-events-none object-contain"
          style={startupLoadingLogoStyle}
          decoding="async"
          fetchPriority="high"
        />
      )}
    </div>
  );
}
