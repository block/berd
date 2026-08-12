import { invoke } from "@tauri-apps/api/core";

/**
 * Identity resolved by kgoose `v3/whoami` from the Cloudflare Access context.
 * Every field is optional: kgoose may return a partial identity, and callers
 * must treat a missing `email` as "no identity".
 */
export interface WhoAmI {
  creator?: string;
  email?: string;
  ldap?: string;
  callerType?: string;
  name?: string;
}

/**
 * Resolves the current user's identity via the `whoami` Tauri command.
 *
 * Returns `null` if the round-trip rejects for any reason (off-WARP, access
 * gate, parse error). Never throws, so callers can fall back to anonymous.
 */
export async function whoami(): Promise<WhoAmI | null> {
  try {
    return await invoke<WhoAmI>("whoami");
  } catch {
    return null;
  }
}
