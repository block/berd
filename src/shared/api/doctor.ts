import { invoke } from "@tauri-apps/api/core";

export type FixType =
  | "command"
  | "bridge"
  | "auth"
  | "updateMain"
  | "updateBridge";

export type AuthStatus = "authenticated" | "notAuthenticated" | "notApplicable";

export type InstallSource =
  | "brew"
  | "npm"
  | "cargo"
  | "mise"
  | "asdf"
  | "curlPipe"
  | "system"
  | "bundled"
  | "unknown";

// Version + install-source readout for one binary behind an agent check. An
// AI-agent check may front two distinct binaries -- the agent's own CLI
// (`main`) and its ACP bridge (`bridge`) -- installed and versioned
// independently. Mirrors the crate's `AgentVersionInfo` (camelCase serde).
export interface AgentVersionInfo {
  installSource: InstallSource | null;
  installedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean | null;
  selfUpdating: boolean | null;
  // Source-aware shell command to update this binary (e.g.
  // `npm install -g <pkg>@latest`, `brew upgrade <pkg>`). Set only when an
  // update is both computable for the install source and actionable. Pairs
  // with `updateFixType`.
  updateCommand?: string | null;
  // `'updateMain'` for the main CLI readout, `'updateBridge'` for the ACP
  // bridge readout. Always paired with `updateCommand`.
  updateFixType?: FixType | null;
  // True when this binary ships inside Berd's app bundle (resolved from the
  // bundled ACP tools dir rather than a user install). Stamped by the doctor
  // crate alongside `installSource === "bundled"`.
  bundled?: boolean | null;
}

export interface DoctorCheck {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  message: string;
  fixUrl: string | null;
  fixCommand: string | null;
  fixType: FixType | null;
  path: string | null;
  bridgePath: string | null;
  rawOutput: string | null;
  authStatus: AuthStatus | null;
  // Flat readout, kept for backward compatibility: mirrors `bridge` when a
  // bridge exists, otherwise `main`.
  installedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean | null;
  installSource: InstallSource | null;
  // Whether the tool keeps itself up to date (curl/native installers such as
  // Claude native, Cursor, Amp-curl). When true the freshness pass reports
  // versions for display but suppresses `updateAvailable` -- report-only,
  // never an update nag. Only populated by the freshness pass.
  selfUpdating: boolean | null;
  // Independent readouts for the agent's own CLI and its ACP bridge, so the
  // two can be surfaced side by side instead of collapsed. `null` for
  // non-agent checks (and `bridge` is `null` for single-binary agents).
  main: AgentVersionInfo | null;
  bridge: AgentVersionInfo | null;
  category: string;
  categoryLabel: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
}

export async function runDoctor(): Promise<DoctorReport> {
  return invoke("run_doctor");
}

// Same report shape as `runDoctor`, but the backend additionally runs the
// freshness pass (installed/latest version + update-available). This touches
// the network / binary `--version` probes, so it is meant to run off the
// synchronous status-read path — see `refreshDoctorReportFreshness`.
export async function runDoctorFresh(): Promise<DoctorReport> {
  return invoke("run_doctor_fresh");
}

export async function runDoctorFix(
  checkId: string,
  fixType: FixType,
): Promise<void> {
  return invoke("run_doctor_fix", { checkId, fixType });
}
