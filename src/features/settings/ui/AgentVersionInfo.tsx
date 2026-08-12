import { useTranslation } from "react-i18next";
import { cn } from "@/shared/lib/cn";
import type { DoctorCheck, InstallSource } from "@/shared/api/doctor";
import {
  describeAgentVersion,
  type AgentBinaryReadout,
} from "../lib/agentVersionDisplay";

const SOURCE_LABEL_KEYS: Record<InstallSource, string> = {
  brew: "doctor.version.source.brew",
  npm: "doctor.version.source.npm",
  cargo: "doctor.version.source.cargo",
  mise: "doctor.version.source.mise",
  asdf: "doctor.version.source.asdf",
  curlPipe: "doctor.version.source.curlPipe",
  system: "doctor.version.source.system",
  bundled: "doctor.version.source.bundled",
  unknown: "doctor.version.source.unknown",
};

// Prefix a bare "1.2.3" with "v"; leave "v1.2.3", channel names, etc. as-is.
function formatVersion(version: string): string {
  return /^\d/.test(version) ? `v${version}` : version;
}

interface AgentVersionInfoProps {
  check: DoctorCheck;
  className?: string;
}

export function AgentVersionInfo({ check, className }: AgentVersionInfoProps) {
  const { t } = useTranslation(["settings", "common"]);
  const display = describeAgentVersion(check);
  if (!display) return null;

  const sourceName = (source: InstallSource | null): string | null =>
    source ? t(SOURCE_LABEL_KEYS[source]) : null;

  const readoutText = (readout: AgentBinaryReadout): string => {
    const version = readout.installedVersion
      ? formatVersion(readout.installedVersion)
      : null;
    const source = sourceName(readout.installSource);

    if (readout.role === "single") {
      if (source && version) {
        return t("doctor.version.line.full", { source, version });
      }
      if (source) return t("doctor.version.line.sourceOnly", { source });
      if (version) return t("doctor.version.line.versionOnly", { version });
      return "";
    }

    const name =
      readout.role === "bridge" ? t("doctor.version.bridge") : check.label;
    if (source && version) {
      return t("doctor.version.line.named", { name, version, source });
    }
    if (source) {
      return t("doctor.version.line.namedSourceOnly", { name, source });
    }
    if (version) {
      return t("doctor.version.line.namedVersionOnly", { name, version });
    }
    return name;
  };

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {display.readouts.map((readout) => {
        const text = readoutText(readout);
        const latest = readout.latestVersion
          ? formatVersion(readout.latestVersion)
          : null;
        // Bundled readouts never carry an update nag: the crate stamps them
        // and suppresses `updateAvailable` — they update with Berd itself.
        const showUpdate = readout.updateAvailable;
        return (
          <div key={readout.role} className="flex flex-col text-xs break-words">
            <span className="text-muted-foreground">{text}</span>
            {showUpdate && latest && (
              <span className="text-warning">
                {t("doctor.version.updateAvailable", { version: latest })}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
