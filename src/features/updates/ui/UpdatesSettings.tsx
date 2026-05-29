import { useTranslation } from "react-i18next";
import {
  type UpdateStatus,
  useUpdaterContext,
} from "@/features/updates/hooks/useUpdater";
import { cn } from "@/shared/lib/cn";
import { Button, type ButtonProps } from "@/shared/ui/button";
import { Progress } from "@/shared/ui/progress";
import { SettingsPage } from "@/shared/ui/SettingsPage";

const STATUS_KEY: Record<UpdateStatus, string> = {
  unavailable: "unavailable",
  idle: "idle",
  checking: "checking",
  "up-to-date": "upToDate",
  available: "available",
  downloading: "downloading",
  installing: "installing",
  ready: "ready",
  error: "error",
};

function isCheckDisabled(status: UpdateStatus) {
  return (
    status === "checking" ||
    status === "available" ||
    status === "downloading" ||
    status === "installing" ||
    status === "ready"
  );
}

const updateActionButtonProps = {
  size: "default",
} satisfies Pick<ButtonProps, "size">;

export function UpdatesSettings() {
  const { t } = useTranslation("settings");
  const {
    status,
    enabled,
    availableVersion,
    downloadProgress,
    errorMessage,
    checkForUpdate,
    relaunch,
  } = useUpdaterContext();
  const isBusy =
    status === "checking" ||
    status === "downloading" ||
    status === "installing";
  const actionLabel =
    status === "checking"
      ? t("updates.actions.checking")
      : status === "error"
        ? t("updates.actions.retry")
        : t("updates.actions.check");

  return (
    <SettingsPage contentClassName="space-y-6">
      <section className="overflow-hidden rounded-lg bg-background px-6 py-5">
        <div className="space-y-1">
          <h4 className="text-sm text-foreground">{t("updates.card.title")}</h4>
          <p className="text-xs leading-4 text-muted-foreground">
            {t("updates.card.description")}
          </p>
        </div>

        <div className="mt-6 flex items-center justify-between gap-6">
          <div className="min-w-0 flex-1 text-sm leading-5">
            {t("updates.card.checkPrompt")}
          </div>
          {status === "ready" ? (
            <Button
              type="button"
              {...updateActionButtonProps}
              onClick={() => void relaunch()}
            >
              {t("updates.actions.restart")}
            </Button>
          ) : (
            <Button
              type="button"
              {...updateActionButtonProps}
              onClick={() => void checkForUpdate()}
              disabled={!enabled || isCheckDisabled(status)}
              feedbackState={isBusy ? "loading" : "idle"}
              loadingLabel={actionLabel}
              preserveWidth
            >
              {actionLabel}
            </Button>
          )}
        </div>

        {status !== "idle" ? (
          <p
            className={cn(
              "mt-4 text-xs leading-4 text-muted-foreground",
              status === "error" && "text-destructive",
            )}
          >
            {status === "error" && errorMessage
              ? errorMessage
              : t(`updates.details.${STATUS_KEY[status]}`, {
                  version: availableVersion ?? "",
                })}
          </p>
        ) : null}

        {(status === "downloading" || status === "installing") && (
          <div className="mt-4">
            <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span>{t(`updates.progress.${STATUS_KEY[status]}`)}</span>
              {downloadProgress != null ? (
                <span>
                  {t("updates.progress.percent", {
                    progress: downloadProgress,
                  })}
                </span>
              ) : null}
            </div>
            <Progress
              className="mt-2"
              value={downloadProgress ?? (status === "installing" ? 100 : 0)}
            />
          </div>
        )}
      </section>
    </SettingsPage>
  );
}
