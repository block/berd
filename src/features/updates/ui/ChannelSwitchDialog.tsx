import { useTranslation } from "react-i18next";
import { useUpdaterContext } from "@/features/updates/hooks/useUpdater";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";

export function ChannelSwitchDialog() {
  const { t } = useTranslation("settings");
  const {
    preparedSwitch,
    runtime,
    cancelPreparedSwitch,
    confirmPreparedSwitch,
  } = useUpdaterContext();
  const sourceLabel =
    runtime.channels.find(
      (channel) => channel.id === runtime.runningBuild?.channelId,
    )?.label ?? t("updates.channel.unknown");
  const targetIsBeta = preparedSwitch?.channelId === "beta";

  return (
    <AlertDialog
      open={preparedSwitch !== null}
      onOpenChange={(open) => {
        if (!open) cancelPreparedSwitch();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {preparedSwitch
              ? t("updates.switchDialog.title", {
                  channel: preparedSwitch.channelLabel,
                })
              : ""}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                {targetIsBeta
                  ? t("updates.switchDialog.betaDescription")
                  : t("updates.switchDialog.mainDescription")}
              </p>
              {preparedSwitch ? (
                <p>
                  {t("updates.switchDialog.builds", {
                    source: sourceLabel,
                    currentVersion: preparedSwitch.currentVersion,
                    target: preparedSwitch.channelLabel,
                    targetVersion: preparedSwitch.version,
                  })}
                </p>
              ) : null}
              <p>{t("updates.switchDialog.restartLater")}</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("updates.actions.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              void confirmPreparedSwitch();
            }}
          >
            {preparedSwitch
              ? t("updates.actions.switchTo", {
                  channel: preparedSwitch.channelLabel,
                })
              : ""}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
