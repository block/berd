import { IconCircleArrowUp } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useUpdaterContext } from "@/features/updates/hooks/useUpdater";
import { Button } from "@/shared/ui/button";

/**
 * Floating update button anchored to the bottom-left of the app. It mirrors
 * the chat composer pill on the bottom-right, so the two never overlap, and it
 * lives at the app-shell level so collapsing the sidebar can't hide it. It only
 * appears once an update is downloaded and ready to apply.
 */
export function UpdateButton() {
  const { t } = useTranslation("settings");
  const { status, relaunch } = useUpdaterContext();

  const shouldPreviewReadyUpdate =
    import.meta.env.DEV &&
    import.meta.env.MODE === "development" &&
    import.meta.env.VITE_PREVIEW_READY_UPDATE === "true";
  const isReady = shouldPreviewReadyUpdate || status === "ready";

  if (!isReady) {
    return null;
  }

  return (
    <div className="fixed bottom-3 left-3 z-40">
      <Button
        type="button"
        size="sm"
        leftIcon={<IconCircleArrowUp aria-hidden="true" />}
        onClick={() => {
          if (shouldPreviewReadyUpdate) return;
          void relaunch();
        }}
      >
        {t("updates.actions.update")}
      </Button>
    </div>
  );
}
