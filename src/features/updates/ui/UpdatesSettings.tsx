import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type UpdateStatus,
  useUpdaterContext,
} from "@/features/updates/hooks/useUpdater";
import { Button, type ButtonProps } from "@/shared/ui/button";
import { Progress } from "@/shared/ui/progress";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { SettingsRow } from "@/shared/ui/settings-row";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";

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

interface UpdatesSettingsProps {
  /**
   * When true, renders without its own SettingsPage wrapper (title,
   * description, sticky header) so it can be embedded inside another
   * settings page's SettingsSections -- e.g. the "About" page (rev 3),
   * where the update check and app identity are one concept rather than
   * two separate nav destinations.
   */
  embedded?: boolean;
}

export function UpdatesSettings({ embedded = false }: UpdatesSettingsProps) {
  const { t } = useTranslation("settings");
  const {
    status,
    enabled,
    runtime,
    availableVersion,
    downloadProgress,
    errorMessage,
    errorDetail,
    waitingMessage,
    checkForUpdate,
    prepareChannelSwitch,
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

  const runningChannel = runtime.channels.find(
    (channel) => channel.id === runtime.runningBuild?.channelId,
  );
  const isBusy =
    status === "checking" ||
    status === "downloading" ||
    status === "installing";
  const actionLabel =
    status === "error"
      ? t("updates.actions.retry")
      : t("updates.actions.check");
  const busyLabel =
    status === "downloading"
      ? t("updates.actions.downloading")
      : status === "installing"
        ? t("updates.actions.installing")
        : t("updates.actions.checking");
  const pendingInstall = runtime.pendingInstall;
  const isChannelSwitch =
    pendingInstall != null &&
    pendingInstall.sourceChannelId !== pendingInstall.targetChannelId;
  const restartLabel = isChannelSwitch
    ? t("updates.actions.restartToFinish", {
        channel:
          runtime.channels.find(
            (channel) => channel.id === pendingInstall.targetChannelId,
          )?.label ?? "",
      })
    : t("updates.actions.restart");

  const content = (
    <div className="divide-y divide-border">
      <SettingsRow
        label={t("updates.card.title")}
        description={t("updates.card.description")}
        action={
          currentVersion ? (
            <span className="text-xs text-muted-foreground">
              {t("updates.card.currentVersion", {
                version: currentVersion,
              })}
            </span>
          ) : null
        }
      />

      {runtime.channels.length > 0 ? (
        <SettingsRow
          label={t("updates.channel.title")}
          description={
            runtime.waitingForMain
              ? t("updates.channel.waitingDescription")
              : t("updates.channel.description")
          }
          action={
            runtime.channels.length === 1 ? (
              <span className="text-xs text-muted-foreground">
                {runningChannel?.label ?? runtime.channels[0].label}
              </span>
            ) : (
              <Select
                value={runtime.runningBuild?.channelId}
                disabled={
                  isCheckDisabled(status) || Boolean(runtime.waitingForMain)
                }
                onValueChange={(channelId) => {
                  void prepareChannelSwitch(channelId);
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="min-w-32"
                  aria-label={t("updates.channel.title")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {runtime.channels.map((channel) => (
                    <SelectItem key={channel.id} value={channel.id}>
                      {channel.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )
          }
          details={
            runtime.notice || waitingMessage ? (
              <p className="text-xs leading-4 text-muted-foreground">
                {waitingMessage ?? runtime.notice}
              </p>
            ) : undefined
          }
        />
      ) : null}

      <SettingsRow
        label={t("updates.card.checkPrompt")}
        align="start"
        // This status text used to live in the `details` slot, but details
        // renders *below the whole row* -- its top margin is measured from
        // the bottom of the row's tallest column, which here is the Button
        // action, not the single-line label. That inflated the visual gap
        // no matter the margin value. `description` renders directly under
        // the label inside the same content column, independent of the
        // action's height -- exactly how "App version"'s line above stays
        // tight against its label. Moved the whole status block here.
        description={
          status !== "idle" ? (
            <>
              {status === "error" ? (
                <div className="space-y-1 text-xs leading-4 text-destructive">
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
              ) : (
                <p className="text-xs leading-4 text-muted-foreground">
                  {status === "ready" && isChannelSwitch
                    ? t("updates.details.switchReady", {
                        channel:
                          runtime.channels.find(
                            (channel) =>
                              channel.id === pendingInstall.targetChannelId,
                          )?.label ?? "",
                        version: availableVersion ?? "",
                      })
                    : t(`updates.details.${STATUS_KEY[status]}`, {
                        version: availableVersion ?? "",
                      })}
                </p>
              )}

              {status === "downloading" || status === "installing" ? (
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
                    value={
                      downloadProgress ?? (status === "installing" ? 100 : 0)
                    }
                  />
                </div>
              ) : null}
            </>
          ) : undefined
        }
        action={
          status === "ready" ? (
            <Button
              type="button"
              {...updateActionButtonProps}
              onClick={() => void relaunch()}
            >
              {restartLabel}
            </Button>
          ) : (
            <Button
              type="button"
              {...updateActionButtonProps}
              onClick={() => void checkForUpdate()}
              disabled={
                !enabled ||
                isCheckDisabled(status) ||
                Boolean(runtime.waitingForMain)
              }
              feedbackState={isBusy ? "loading" : "idle"}
              loadingLabel={busyLabel}
              preserveWidth
            >
              {actionLabel}
            </Button>
          )
        }
      />
    </div>
  );

  if (embedded) {
    return content;
  }

  return (
    <SettingsPage
      title={t("updates.title")}
      description={t("updates.description")}
    >
      {content}
    </SettingsPage>
  );
}
