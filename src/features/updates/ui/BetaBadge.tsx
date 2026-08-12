import { useTranslation } from "react-i18next";
import { useUpdaterContext } from "@/features/updates/hooks/useUpdater";
import { useFeedbackDialogStore } from "@/features/feedback/feedbackDialogStore";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { useProfileCapability } from "@/shared/profile/capabilities";

export function BetaBadge() {
  const { t } = useTranslation("settings");
  const { runtime, status, prepareChannelSwitch } = useUpdaterContext();
  const openFeedback = useFeedbackDialogStore((state) => state.openDialog);
  const feedbackEnabled = useProfileCapability("feedback");
  const runningBuild = runtime.runningBuild;
  const previewMode = import.meta.env.DEV && !window.__TAURI_INTERNALS__;
  if (runningBuild?.channelId !== "beta") return null;

  const main = runtime.channels.find((channel) => channel.id === "main");
  const betaLabel =
    runtime.channels.find((channel) => channel.id === "beta")?.label ?? "Beta";
  const betaLabelId = import.meta.env.VITE_BETA_LINEAR_LABEL_ID?.trim();
  const betaFeedbackAvailable =
    feedbackEnabled && (previewMode || Boolean(betaLabelId));
  const switchDisabled =
    !main ||
    status === "checking" ||
    status === "downloading" ||
    status === "installing" ||
    status === "ready";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={t("updates.betaBadge.open")}
        >
          <Badge variant="secondary">{betaLabel}</Badge>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="space-y-4">
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">
            {t("updates.betaBadge.title")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("updates.betaBadge.build", { version: runningBuild.version })}
          </p>
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-foreground">
            {t("updates.betaBadge.whatToTest")}
          </p>
          <p className="text-xs leading-4 text-muted-foreground">
            {runningBuild.whatToTest ??
              t("updates.betaBadge.defaultWhatToTest")}
          </p>
        </div>
        {runtime.waitingForMain ? (
          <p className="text-xs leading-4 text-muted-foreground">
            {t("updates.betaBadge.waitingForMain")}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {feedbackEnabled ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!betaFeedbackAvailable}
              title={
                betaFeedbackAvailable
                  ? undefined
                  : t("updates.betaBadge.reportIssueUnavailable")
              }
              onClick={() => {
                openFeedback({
                  title: "",
                  description: "",
                  includeLogs: false,
                  titleSuffix: ` [Berd ${runningBuild.version} ${betaLabel}]`,
                  metadata: {
                    "Release channel": betaLabel,
                    "Running build": runningBuild.version,
                  },
                  labelIds: betaLabelId ? [betaLabelId] : [],
                });
              }}
            >
              {t("updates.betaBadge.reportIssue")}
            </Button>
          ) : null}
          {main ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={switchDisabled || Boolean(runtime.waitingForMain)}
              onClick={() => void prepareChannelSwitch(main.id)}
            >
              {t("updates.actions.switchTo", { channel: main.label })}
            </Button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
