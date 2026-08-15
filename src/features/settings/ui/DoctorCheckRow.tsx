import { useState } from "react";
import {
  CheckCircle,
  AlertTriangle,
  XCircle,
  ExternalLink,
  Wrench,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { SettingsRow } from "@/shared/ui/settings-row";
import { Spinner } from "@/shared/ui/spinner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import {
  runDoctorFix,
  type DoctorCheck,
  type FixType,
} from "@/shared/api/doctor";
import { useTranslation } from "react-i18next";
import { AgentVersionInfo } from "./AgentVersionInfo";

interface DoctorCheckRowProps {
  check: DoctorCheck;
  onFixed?: () => void;
}

const STATUS_ICON = {
  pass: CheckCircle,
  warn: AlertTriangle,
  fail: XCircle,
} as const;

const STATUS_COLOR = {
  pass: "text-status-added",
  warn: "text-warning",
  fail: "text-destructive",
} as const;

export function DoctorCheckRow({ check, onFixed }: DoctorCheckRowProps) {
  const { t } = useTranslation(["settings", "common"]);
  const [showFixDialog, setShowFixDialog] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [fixError, setFixError] = useState<string | null>(null);
  const [activeFix, setActiveFix] = useState<{
    fixType: FixType;
    command: string;
  } | null>(null);

  const Icon = STATUS_ICON[check.status];

  function openInstallFixDialog() {
    if (!check.fixType || !check.fixCommand) return;
    setFixError(null);
    setFixing(false);
    setActiveFix({
      fixType: check.fixType,
      command: check.fixCommand,
    });
    setShowFixDialog(true);
  }

  async function confirmFix() {
    if (!activeFix) return;
    setFixing(true);
    setFixError(null);
    try {
      await runDoctorFix(check.id, activeFix.fixType);
      setShowFixDialog(false);
      onFixed?.();
    } catch (e) {
      setFixError(String(e));
    } finally {
      setFixing(false);
    }
  }

  return (
    <>
      <SettingsRow
        density="compact"
        align="start"
        leading={
          <Icon
            className={cn("h-4 w-4 flex-shrink-0", STATUS_COLOR[check.status])}
          />
        }
        label={check.label}
        description={
          <>
            <span className="block break-words">{check.message}</span>
            {check.path ? (
              <span className="block break-words font-mono text-[10px]">
                {check.main?.bundled ? t("doctor.bundledPath") : check.path}
              </span>
            ) : null}
            {check.bridgePath ? (
              <span className="block break-words font-mono text-[10px]">
                {check.bridge?.bundled
                  ? t("doctor.bundledPath")
                  : check.bridgePath}
              </span>
            ) : null}
            <AgentVersionInfo check={check} className="mt-0.5" />
          </>
        }
        action={
          check.status !== "pass" && (check.fixType || check.fixUrl) ? (
            <div className="flex items-center gap-1.5">
              {check.fixType ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  leftIcon={<Wrench />}
                  onClick={openInstallFixDialog}
                  className="flex-shrink-0"
                >
                  {t("common:actions.fix")}
                </Button>
              ) : null}
              {check.fixUrl ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("common:buttons.openFixUrl")}
                  onClick={() => {
                    if (check.fixUrl) void openUrl(check.fixUrl);
                  }}
                  className="flex-shrink-0"
                >
                  <ExternalLink />
                </Button>
              ) : null}
            </div>
          ) : undefined
        }
      />

      <AlertDialog
        open={showFixDialog}
        onOpenChange={(open) => {
          if (!open && !fixing) setShowFixDialog(false);
        }}
      >
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings:doctor.runFix")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings:doctor.runFixDescription")}
            </AlertDialogDescription>
            <code className="block break-all rounded bg-muted px-3 py-2 font-mono text-xs">
              {activeFix?.command ?? check.fixCommand}
            </code>
          </AlertDialogHeader>
          {fixError && <p className="text-xs text-destructive">{fixError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={fixing}>
              {t("common:actions.cancel")}
            </AlertDialogCancel>
            <Button disabled={fixing} onClick={confirmFix}>
              {fixing && <Spinner className="h-3 w-3" />}
              {fixing
                ? t("common:actions.running")
                : fixError
                  ? t("common:actions.retry")
                  : t("common:actions.run")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
