import { isMemorySupported } from "@/features/me/lib/memoryAvailability";
import {
  readMemoryPolicy as readPolicy,
  writeMemoryPolicy as writePolicy,
  type MemoryPolicy,
} from "@/shared/api/system";

/** Missing, malformed, or unavailable policy fails closed. */
export async function readMemoryPolicy(): Promise<MemoryPolicy | null> {
  if (!isMemorySupported()) return null;
  try {
    const policy = await readPolicy();
    return typeof policy?.enabled === "boolean"
      ? { enabled: policy.enabled }
      : null;
  } catch {
    return null;
  }
}

export async function isMemoryEnabledByPolicy(): Promise<boolean> {
  return (await readMemoryPolicy())?.enabled === true;
}

/** Persist only the defined on/off flag, never arbitrary policy fields. */
export async function writeMemoryPolicy(enabled: boolean): Promise<boolean> {
  if (!isMemorySupported()) return false;
  try {
    await writePolicy(enabled);
    return true;
  } catch {
    return false;
  }
}
