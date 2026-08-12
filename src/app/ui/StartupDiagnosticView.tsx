import { appLogDir } from "@tauri-apps/api/path";
import { openPath } from "@tauri-apps/plugin-opener";
import { ClipboardCopy, FolderOpen, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/shared/ui/button";
import {
  buildStartupDiagnosticReport,
  type StartupDiagnosticIssue,
} from "../lib/startupDiagnostics";

interface StartupDiagnosticViewProps {
  issue: StartupDiagnosticIssue;
  onRetry: () => void;
}

export function StartupDiagnosticView({
  issue,
  onRetry,
}: StartupDiagnosticViewProps) {
  const { t } = useTranslation("common");

  async function copyText(text: string) {
    try {
      const clipboard = globalThis.navigator?.clipboard;
      if (!clipboard?.writeText) {
        throw new Error(t("errors.clipboardUnavailable"));
      }
      await clipboard.writeText(text);
      toast.success(t("startup.error.copySuccess"));
    } catch {
      toast.error(t("startup.error.copyFailed"));
    }
  }

  async function handleOpenLogsFolder() {
    try {
      await openPath(await appLogDir());
    } catch {
      toast.error(t("startup.error.openLogsFailed"));
    }
  }

  return (
    <div
      className="flex h-screen w-screen items-center justify-center bg-canvas-base px-6 text-foreground"
      data-tauri-drag-region
    >
      <div className="flex w-full max-w-xl flex-col items-center gap-4 text-center">
        <div className="flex flex-col gap-2">
          <h1 className="text-lg font-medium text-primary">
            {t(issue.titleKey)}
          </h1>
          <p className="text-sm leading-6 text-muted-foreground">
            {t(issue.descriptionKey)}
          </p>
        </div>

        {issue.kind === "network-warp" ? (
          <ol className="flex w-full max-w-sm flex-col gap-3 self-center text-left">
            <li className="flex items-center gap-3">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                1
              </span>
              <span className="text-base font-semibold text-foreground">
                {t("startup.error.networkWarp.steps.connect")}
              </span>
            </li>
            <li className="flex items-center gap-3">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border text-sm font-medium text-muted-foreground">
                2
              </span>
              <span className="text-sm text-muted-foreground">
                {t("startup.error.networkWarp.steps.retry")}
              </span>
            </li>
          </ol>
        ) : null}

        <div className="flex flex-wrap justify-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            leftIcon={<RefreshCw aria-hidden="true" />}
            onClick={onRetry}
          >
            {t("actions.retry")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            leftIcon={<ClipboardCopy aria-hidden="true" />}
            onClick={() => void copyText(buildStartupDiagnosticReport(issue))}
          >
            {t("startup.error.copyDetails")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            leftIcon={<FolderOpen aria-hidden="true" />}
            onClick={() => void handleOpenLogsFolder()}
          >
            {t("startup.error.openLogsFolder")}
          </Button>
        </div>

        <details className="w-full rounded-md border border-border bg-muted/30 p-3 text-left">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
            {t("startup.error.technicalDetails")}
          </summary>
          <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background p-3 text-xs text-muted-foreground">
            {issue.rawError}
          </pre>
          {issue.connectivityProbe ? (
            <>
              <div className="mt-3 text-xs font-medium text-muted-foreground">
                {t("startup.error.connectivityProbeLabel")}
              </div>
              <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background p-3 text-xs text-muted-foreground">
                {issue.connectivityProbe}
              </pre>
            </>
          ) : null}
        </details>
      </div>
    </div>
  );
}
