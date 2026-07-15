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
    commandOverride: string | null;
  } | null>(null);

  const Icon = STATUS_ICON[check.status];

  function openInstallFixDialog() {
    if (!check.fixType || !check.fixCommand) return;
    setFixError(null);
    setFixing(false);
    setActiveFix({
      fixType: check.fixType,
      command: check.fixCommand,
      commandOverride: null,
    });
    setShowFixDialog(true);
  }

  async function confirmFix() {
    if (!activeFix) return;
    setFixing(true);
    setFixError(null);
    try {
      await runDoctorFix(
        check.id,
        activeFix.fixType,
        activeFix.commandOverride ?? undefined,
      );
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
      <div className="flex items-center gap-2.5 rounded-md bg-background px-3.5 py-2.5">
        <Icon
          className={cn("h-4 w-4 flex-shrink-0", STATUS_COLOR[check.status])}
        />

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm">{check.label}</span>
          <span className="break-words text-xs text-muted-foreground">
            {check.message}
          </span>
          {check.path && (
            <span className="break-words font-mono text-[10px] text-muted-foreground">
              {check.main?.bundled ? t("doctor.bundledPath") : check.path}
            </span>
          )}
          {check.bridgePath && (
            <span className="break-words font-mono text-[10px] text-muted-foreground">
              {check.bridge?.bundled
                ? t("doctor.bundledPath")
                : check.bridgePath}
            </span>
          )}
          <AgentVersionInfo check={check} className="mt-0.5" />
        </div>

        {check.fixType && check.status !== "pass" && (
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
        )}

        {check.fixUrl && check.status !== "pass" && (
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
        )}
      </div>

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
