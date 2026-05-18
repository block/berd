import { useState, useEffect, useRef, useCallback } from "react";
import { RefreshCw, ClipboardCopy, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import { Spinner } from "@/shared/ui/spinner";
import {
  runDoctor,
  type DoctorCheck,
  type DoctorReport,
} from "@/shared/api/doctor";
import { DoctorCheckRow } from "./DoctorCheckRow";
import { SettingsPage } from "@/shared/ui/SettingsPage";

interface DoctorCheckGroup {
  category: string;
  categoryLabel: string;
  checks: DoctorCheck[];
}

// Hide upstream Doctor agent checks because Goose's ACP layer manages agent
// state separately, and the two views can differ. The Providers page is the
// source of truth for agent setup and status in this app.
const HIDDEN_DOCTOR_CATEGORIES = new Set(["agents"]);

function groupDoctorChecks(checks: DoctorCheck[]): DoctorCheckGroup[] {
  const groups = new Map<string, DoctorCheckGroup>();

  for (const check of checks) {
    if (HIDDEN_DOCTOR_CATEGORIES.has(check.category)) {
      continue;
    }

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

export function formatDebugReport(report: DoctorReport): string {
  const STATUS_ICONS: Record<DoctorCheck["status"], string> = {
    pass: "\u2713",
    warn: "\u26A0",
    fail: "\u2717",
  };

  const lines: string[] = [
    "Goose Doctor Report",
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

export function DoctorSettings() {
  const { t } = useTranslation(["settings", "common"]);
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const mountedRef = useRef(true);

  const runChecks = useCallback(async () => {
    setLoading(true);
    try {
      const result = await runDoctor();
      if (mountedRef.current) setReport(result);
    } catch (e) {
      console.error("[Doctor] Failed to run checks:", e);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    runChecks();
    return () => {
      mountedRef.current = false;
    };
  }, [runChecks]);

  const checkGroups = report ? groupDoctorChecks(report.checks) : [];

  async function copyDebugInfo() {
    if (!report) return;
    await navigator.clipboard.writeText(formatDebugReport(report));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <SettingsPage
      title={t("doctor.title")}
      actions={
        <>
          {report && !loading && (
            <Button
              type="button"
              variant="outline"
              size="xxs"
              onClick={copyDebugInfo}
            >
              {copied ? (
                <Check className="size-3.5" />
              ) : (
                <ClipboardCopy className="size-3.5" />
              )}
              {copied ? t("doctor.copied") : t("doctor.copyDetails")}
            </Button>
          )}

          {!loading && (
            <Button
              type="button"
              variant="outline"
              size="xxs"
              onClick={runChecks}
            >
              <RefreshCw className="size-3.5" />
              {t("doctor.rerun")}
            </Button>
          )}
        </>
      }
    >
      {loading ? (
        <div className="flex min-h-[160px] items-center justify-center gap-2 text-sm text-muted-foreground">
          <Spinner className="h-5 w-5" />
          {t("doctor.running")}
        </div>
      ) : report ? (
        <div className="space-y-6">
          {checkGroups.map((group) => (
            <div
              key={group.category}
              className="mx-auto w-full max-w-xl space-y-2"
            >
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {group.categoryLabel}
              </h4>
              <div className="space-y-2">
                {group.checks.map((check) => (
                  <DoctorCheckRow
                    key={check.id}
                    check={check}
                    onFixed={runChecks}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex min-h-[160px] items-center justify-center text-sm text-muted-foreground">
          {t("doctor.empty")}
        </div>
      )}
    </SettingsPage>
  );
}
