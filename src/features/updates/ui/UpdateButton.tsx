import { IconCircleArrowUp } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useUpdaterContext } from "@/features/updates/hooks/useUpdater";
import { Button } from "@/shared/ui/button";

/** Shell-level restart affordance shown only after an update is installed. */
export function UpdateButton() {
  const { t } = useTranslation("settings");
  const { status, runtime, relaunch } = useUpdaterContext();

  const shouldPreviewReadyUpdate =
    import.meta.env.DEV &&
    import.meta.env.MODE === "development" &&
    import.meta.env.VITE_PREVIEW_READY_UPDATE === "true";
  const isReady = shouldPreviewReadyUpdate || status === "ready";
  if (!isReady) return null;

  const pendingInstall = runtime.pendingInstall;
  const isChannelSwitch =
    pendingInstall != null &&
    pendingInstall.sourceChannelId !== pendingInstall.targetChannelId;
  const pendingChannel = isChannelSwitch
    ? runtime.channels.find(
        (channel) => channel.id === pendingInstall.targetChannelId,
      )
    : undefined;
  const label = pendingChannel
    ? t("updates.actions.restartToFinish", { channel: pendingChannel.label })
    : t("updates.actions.update");

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
        {label}
      </Button>
    </div>
  );
}
