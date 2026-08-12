import { invoke } from "@tauri-apps/api/core";

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export interface KgooseProbeReport {
  likelyWarpFailure: boolean;
  status: number | null;
  kind: string;
  message: string;
}

/**
 * Issues the Rust `probe_kgoose_connectivity` command, which pokes a known
 * behind-WARP kgoose endpoint to decide whether a failure is a WARP/VPN
 * connectivity problem. Both startup and the updater sit behind the same
 * Cloudflare WARP / Access layer, so this probe is a shared proxy for
 * "is WARP up?".
 *
 * A probe that hangs past `timeoutMs` is itself treated as a likely WARP
 * failure; an outright probe error returns `null` (we couldn't tell).
 */
export async function probeKgooseConnectivity(
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<KgooseProbeReport | null> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const probePromise = invoke<KgooseProbeReport>("probe_kgoose_connectivity");
    const timeout = new Promise<KgooseProbeReport>((resolve) => {
      timeoutId = setTimeout(() => {
        // A hung probe is itself evidence the network path is broken;
        // surface that as a likely WARP failure so the UI can suggest the
        // right next step instead of waiting forever.
        resolve({
          likelyWarpFailure: true,
          status: null,
          kind: "request",
          message: "kgoose probe timed out",
        });
      }, timeoutMs);
    });
    return await Promise.race([probePromise, timeout]);
  } catch (probeError) {
    console.error("Failed to probe kgoose connectivity:", probeError);
    return null;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
