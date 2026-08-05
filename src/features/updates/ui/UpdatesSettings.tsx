import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type UpdateStatus,
  useUpdaterContext,
} from "@/features/updates/hooks/useUpdater";
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
    errorDetail,
    checkForUpdate,
    relaunch,
  } = useUpdaterContext();
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadVersion() {
      if (!window.__TAURI_INTERNALS__) return;
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        const version = await getVersion();
        if (!cancelled) setCurrentVersion(version);
      } catch {
        // non-critical — leave version hidden
      }
    }
    void loadVersion();
    return () => {
      cancelled = true;
    };
  }, []);
  const isBusy =
    status === "checking" ||
    status === "downloading" ||
    status === "installing";
  // The resting label and the busy label must stay distinct strings. Deriving
  // both from one value made the button cross-fade a label onto an identical
  // copy offset by the spinner slot, which read as garbled text (BOT-1466).
  const actionLabel =
    status === "error"
      ? t("updates.actions.retry")
      : t("updates.actions.check");
  // The same button stays in its loading state across the whole busy run, so
  // the busy label has to track the phase or it contradicts the progress row
  // below it.
  const busyLabel =
    status === "downloading"
      ? t("updates.actions.downloading")
      : status === "installing"
        ? t("updates.actions.installing")
        : t("updates.actions.checking");

  return (
    <SettingsPage contentClassName="space-y-6">
      <section className="overflow-hidden rounded-md bg-background px-6 py-5">
        <div className="space-y-1">
          <div className="flex items-baseline justify-between gap-2">
            <h4 className="text-sm text-foreground">
              {t("updates.card.title")}
            </h4>
            {currentVersion ? (
              <span className="text-xs text-muted-foreground">
                {t("updates.card.currentVersion", {
                  version: currentVersion,
                })}
              </span>
            ) : null}
          </div>
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
              loadingLabel={busyLabel}
              preserveWidth
            >
              {actionLabel}
            </Button>
          )}
        </div>

        {status === "error" ? (
          <div className="mt-4 space-y-1 text-xs leading-4 text-destructive">
            <p>
              {errorMessage ??
                t(`updates.details.${STATUS_KEY[status]}`, {
                  version: availableVersion ?? "",
                })}
            </p>
            {errorDetail && errorDetail !== errorMessage ? (
              <p className="whitespace-pre-wrap break-words text-muted-foreground">
                {t("updates.errors.detail", { detail: errorDetail })}
              </p>
            ) : null}
          </div>
        ) : status !== "idle" ? (
          <p className="mt-4 text-xs leading-4 text-muted-foreground">
            {t(`updates.details.${STATUS_KEY[status]}`, {
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
