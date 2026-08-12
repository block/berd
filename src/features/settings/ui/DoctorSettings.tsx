import { useState, useEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw, ClipboardCopy, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import { Spinner } from "@/shared/ui/spinner";
import type { DoctorCheck, DoctorReport } from "@/shared/api/doctor";
import {
  useDoctorReport,
  rerunDoctorReport,
} from "@/shared/api/useDoctorReport";
import {
  describeAgentVersion,
  type AgentBinaryReadout,
} from "@/features/settings/lib/agentVersionDisplay";
import { DoctorCheckRow } from "./DoctorCheckRow";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import {
  SettingsSection,
  SettingsSections,
} from "@/shared/ui/settings-section";

const DOCTOR_LONG_RUNNING_HINT_DELAY_MS = 5_000;
const DOCTOR_REPORT_TIMEOUT_SECONDS = 60;

interface DoctorCheckGroup {
  category: string;
  categoryLabel: string;
  checks: DoctorCheck[];
}

function groupDoctorChecks(checks: DoctorCheck[]): DoctorCheckGroup[] {
  const groups = new Map<string, DoctorCheckGroup>();

  for (const check of checks) {
    const group = groups.get(check.category);
    if (group) {
      group.checks.push(check);
    } else {
      groups.set(check.category, {
        category: check.category,
        categoryLabel: check.categoryLabel,
        checks: [check],
      });
    }
  }

  return Array.from(groups.values());
}

function readoutLabel(readout: AgentBinaryReadout): string {
  return readout.role === "main"
    ? " (main)"
    : readout.role === "bridge"
      ? " (bridge)"
      : "";
}

function versionLines(check: DoctorCheck): string[] {
  const display = describeAgentVersion(check);
  if (!display) return [];
  const lines: string[] = [];
  for (const readout of display.readouts) {
    const suffix = readoutLabel(readout);
    if (readout.installSource) {
      lines.push(`Install source${suffix}: ${readout.installSource}`);
    }
    if (readout.installedVersion) {
      lines.push(`Installed version${suffix}: ${readout.installedVersion}`);
    }
    if (readout.latestVersion) {
      lines.push(`Latest version${suffix}: ${readout.latestVersion}`);
    }
    if (readout.updateAvailable) {
      lines.push(`Update available${suffix}: yes`);
    }
    if (readout.selfUpdating) {
      lines.push(`Self-updating${suffix}: yes`);
    }
  }
  return lines;
}

function useLoadingElapsedSeconds(loading: boolean): number {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [previousLoading, setPreviousLoading] = useState(loading);
  if (previousLoading !== loading) {
    setPreviousLoading(loading);
    setElapsedSeconds(0);
  }

  useEffect(() => {
    if (!loading) {
      return;
    }

    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    return () => window.clearInterval(interval);
  }, [loading]);

  return loading ? elapsedSeconds : 0;
}

export function formatDebugReport(report: DoctorReport): string {
  const STATUS_ICONS: Record<DoctorCheck["status"], string> = {
    pass: "\u2713",
    warn: "\u26A0",
    fail: "\u2717",
  };

  const lines: string[] = [
    "Berd Doctor Report",
    `Date: ${new Date().toISOString()}`,
    "=".repeat(60),
  ];

  for (const group of groupDoctorChecks(report.checks)) {
    lines.push("");
    lines.push(`${group.categoryLabel} (${group.category})`);
    lines.push("-".repeat(60));

    for (const check of group.checks) {
      const icon = STATUS_ICONS[check.status];
      lines.push("");
      lines.push(
        `${icon} [${check.status.toUpperCase()}] ${check.label} (${check.id})`,
      );
      lines.push(`  Message: ${check.message}`);
      if (check.path) lines.push(`  Path: ${check.path}`);
      if (check.bridgePath) lines.push(`  Bridge path: ${check.bridgePath}`);
      if (check.authStatus) lines.push(`  Auth status: ${check.authStatus}`);
      for (const line of versionLines(check)) lines.push(`  ${line}`);
      if (check.fixUrl) lines.push(`  Fix URL: ${check.fixUrl}`);
      if (check.fixCommand) lines.push(`  Fix command: ${check.fixCommand}`);
      if (check.rawOutput) {
        lines.push("  --- raw output ---");
        for (const line of check.rawOutput.split("\n")) {
          lines.push(`  ${line}`);
        }
        lines.push("  --- end raw output ---");
      }
    }
  }

  lines.push("");
  lines.push("=".repeat(60));
  return lines.join("\n");
}

interface DoctorSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Doctor (rev 4): moved from a hidden full-page sub-route (reached via a row
// in System) into a dialog opened directly from that row -- feedback was
// that Doctor being the only settings surface with a deeper nav level felt
// off, especially now that its action buttons (Copy report/Rerun) already
// live in a settings-surface actions slot rather than the app's top bar,
// which is what made a dialog workable. The content/logic below (grouping,
// the report query, the loading/elapsed-time states, the debug-report
// formatter) is otherwise unchanged from the page version -- only the outer
// shell moved from SettingsPage+BreadcrumbTrail to Dialog/DialogContent.
export function DoctorSettings({ open, onOpenChange }: DoctorSettingsProps) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);

  const query = useDoctorReport();
  const report = query.data ?? null;
  // `isPending` is only true before the first result, so a warm prefetch
  // renders the dialog instantly; `isFetching` keeps the spinner up during a
  // manual rerun.
  const loading = query.isPending || query.isFetching;
  const elapsedSeconds = useLoadingElapsedSeconds(loading);
  const showLongRunningHint =
    elapsedSeconds * 1000 >= DOCTOR_LONG_RUNNING_HINT_DELAY_MS;

  const runChecks = useCallback(() => {
    // Re-probe and re-run the freshness pass so version/update badges
    // repopulate instead of blanking after a manual rerun or applied fix.
    void rerunDoctorReport(queryClient);
  }, [queryClient]);

  // The agents category is rendered on the AI providers detail page (with
  // richer install/auth UI); hide it here so Doctor focuses on
  // environment/tools/etc.
  const checkGroups = report
    ? groupDoctorChecks(report.checks).filter(
        (group) => group.category !== "agents",
      )
    : [];

  const copyDebugInfo = useCallback(async () => {
    if (!report) return;
    await navigator.clipboard.writeText(formatDebugReport(report));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [report]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="max-h-[min(720px,calc(100dvh-2rem))]">
        <DialogHeader>
          <DialogTitle>{t("doctor.title")}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {loading ? (
            <div className="flex min-h-[160px] flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
              <div className="flex items-center justify-center gap-2">
                <Spinner className="h-5 w-5" />
                <span>{t("doctor.running")}</span>
              </div>
              {showLongRunningHint ? (
                <p className="text-xs">
                  {t("doctor.longRunning", {
                    seconds: elapsedSeconds,
                    timeoutSeconds: DOCTOR_REPORT_TIMEOUT_SECONDS,
                  })}
                </p>
              ) : null}
            </div>
          ) : report ? (
            <SettingsSections>
              {checkGroups.map((group) => (
                <SettingsSection
                  key={group.category}
                  title={group.categoryLabel}
                >
                  {group.checks.map((check) => (
                    <DoctorCheckRow
                      key={check.id}
                      check={check}
                      onFixed={runChecks}
                    />
                  ))}
                </SettingsSection>
              ))}
            </SettingsSections>
          ) : (
            <div className="flex min-h-[160px] items-center justify-center text-sm text-muted-foreground">
              {t("doctor.empty")}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          {report ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              // React Query keeps the previous report visible while a rerun
              // is loading (see `loading` above), so without this the
              // button stays enabled and would export the stale pre-rerun
              // report during a fix-verification flow, as if it were
              // current. Caught by Builderbot review.
              disabled={loading}
              onClick={() => void copyDebugInfo()}
            >
              {copied ? (
                <Check className="size-3.5" />
              ) : (
                <ClipboardCopy className="size-3.5" />
              )}
              {copied ? t("doctor.copied") : t("doctor.copyDetails")}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={runChecks}
          >
            <RefreshCw className="size-3.5" />
            {t("doctor.rerun")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
