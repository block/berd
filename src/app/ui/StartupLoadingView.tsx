import { useTranslation } from "react-i18next";
import { useReducedMotion } from "motion/react";

import { STARTUP_LOADING_LOGO_SIZE_PX } from "@/app/lib/startupLoading";
import { BerdLoader } from "@/shared/ui/berd-loader";

export function StartupLoadingView() {
  const { t } = useTranslation("common");
  const shouldReduceMotion = useReducedMotion();

  return (
    <div
      className="flex h-screen w-screen select-none items-center justify-center bg-dot-grid text-foreground"
      role="status"
      aria-label={t("startup.loadingLabel")}
      data-tauri-drag-region
    >
      <BerdLoader
        animated={!shouldReduceMotion}
        aria-hidden="true"
        className="pointer-events-none"
        decorative
        size={STARTUP_LOADING_LOGO_SIZE_PX}
      />
    </div>
  );
}
