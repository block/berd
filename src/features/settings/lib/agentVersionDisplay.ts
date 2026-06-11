// Derive a renderable view of an agent check's install-source + version data.
//
// The doctor crate carries two independent readouts per agent check: the
// agent's own CLI (`main`) and its ACP bridge (`bridge`), each with its own
// install source and versions. When the two differ we surface both; otherwise
// we collapse to the flat fields (which the crate keeps populated for
// backward compatibility, mirroring whichever readout exists).
//
// "Update available" is only ever reported as actionable for user-managed
// sources. Self-updating installs (Claude native, Cursor, Amp-curl) report
// their version but never an update nag -- the crate suppresses
// `updateAvailable` for them, and we belt-and-suspenders it here too.

import type {
  AgentVersionInfo,
  DoctorCheck,
  FixType,
  InstallSource,
} from "@/shared/api/doctor";

export type AgentVersionRole = "single" | "main" | "bridge";

// `unknown` means the crate couldn't fingerprint the install source -- it
// carries no signal for the user (Goose itself is the common case). Treat it
// as absent so we never render "Installed via an unknown source"; a readout
// left with nothing else collapses to empty and renders nothing.
function normalizeSource(source: InstallSource | null): InstallSource | null {
  return source === "unknown" ? null : source;
}

export interface AgentBinaryReadout {
  role: AgentVersionRole;
  installSource: InstallSource | null;
  installedVersion: string | null;
  latestVersion: string | null;
  // A newer version exists *and* the crate produced a runnable update command
  // for it. `updateAvailable=true` without `updateCommand` (e.g. a leaky
  // self-updating source) is not actionable.
  updateAvailable: boolean;
  // The tool keeps itself up to date -- report-only, no nag.
  selfUpdating: boolean;
  // Source-aware update command for this readout, e.g.
  // `npm install -g <pkg>@latest`. Defined only when actionable.
  updateCommand: string | null;
  // `'updateMain'` or `'updateBridge'` — paired with `updateCommand`.
  updateFixType: FixType | null;
}

export interface AgentVersionDisplay {
  readouts: AgentBinaryReadout[];
  // Any readout offers an actionable (user-managed) update.
  hasActionableUpdate: boolean;
}

function readoutFromInfo(
  info: AgentVersionInfo,
  role: AgentVersionRole,
): AgentBinaryReadout {
  const selfUpdating = info.selfUpdating === true;
  const updateCommand = info.updateCommand ?? null;
  const updateFixType = info.updateFixType ?? null;
  return {
    role,
    installSource: normalizeSource(info.installSource),
    installedVersion: info.installedVersion,
    latestVersion: info.latestVersion,
    updateAvailable:
      info.updateAvailable === true && !selfUpdating && updateCommand != null,
    selfUpdating,
    updateCommand,
    updateFixType,
  };
}

function readoutFromFlat(check: DoctorCheck): AgentBinaryReadout {
  const selfUpdating = check.selfUpdating === true;
  // The flat fields mirror `bridge` when a bridge exists, otherwise `main`, so
  // borrow the same readout's update command for the collapsed view.
  const source = check.bridge ?? check.main ?? null;
  const updateCommand = source?.updateCommand ?? null;
  const updateFixType = source?.updateFixType ?? null;
  return {
    role: "single",
    installSource: normalizeSource(check.installSource),
    installedVersion: check.installedVersion,
    latestVersion: check.latestVersion,
    updateAvailable:
      check.updateAvailable === true && !selfUpdating && updateCommand != null,
    selfUpdating,
    updateCommand,
    updateFixType,
  };
}

function isEmpty(readout: AgentBinaryReadout): boolean {
  return (
    readout.installSource == null &&
    readout.installedVersion == null &&
    readout.latestVersion == null &&
    !readout.selfUpdating
  );
}

function readoutsDiffer(a: AgentBinaryReadout, b: AgentBinaryReadout): boolean {
  return (
    a.installSource !== b.installSource ||
    a.installedVersion !== b.installedVersion
  );
}

export function describeAgentVersion(
  check: DoctorCheck,
): AgentVersionDisplay | null {
  const main = check.main ? readoutFromInfo(check.main, "main") : null;
  const bridge = check.bridge ? readoutFromInfo(check.bridge, "bridge") : null;

  let readouts: AgentBinaryReadout[];
  if (
    main &&
    bridge &&
    !isEmpty(main) &&
    !isEmpty(bridge) &&
    readoutsDiffer(main, bridge)
  ) {
    readouts = [main, bridge];
  } else {
    const flat = readoutFromFlat(check);
    if (isEmpty(flat)) return null;
    readouts = [flat];
  }

  return {
    readouts,
    hasActionableUpdate: readouts.some((readout) => readout.updateAvailable),
  };
}

// Names of required binaries the doctor report shows missing *while another
// binary for the same agent is present* — i.e. a partial install (the agent's
// CLI is on PATH but its ACP bridge isn't). Returned as a list so a card can
// flag each gap in danger text instead of letting a half-installed agent read
// like a healthy one. A fully-uninstalled agent returns `[]`: its missing-ness
// is already obvious from the Install action and the absent version line, so we
// only call out *partial* gaps here.
export function missingAgentComponents(
  check: DoctorCheck,
  binaryName: string | null | undefined,
): string[] {
  // The crate flags "main CLI present, ACP bridge missing" with
  // fixType="bridge": `path` stays on the main CLI while `bridge`/`bridgePath`
  // are left null. The provider catalog tracks that bridge binary as
  // `binaryName`, so name it from there rather than parsing the human message.
  // This is provider-agnostic — it fires for any two-binary ACP agent in this
  // state, not just Codex.
  if (
    check.fixType === "bridge" &&
    check.bridge == null &&
    check.bridgePath == null &&
    binaryName
  ) {
    return [binaryName];
  }
  return [];
}
