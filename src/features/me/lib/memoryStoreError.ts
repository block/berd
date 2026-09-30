/** Safe, localized categories only: never display or log raw storage errors. */
export type MemoryStoreErrorKind =
  | "missingKey"
  | "keyUnavailable"
  | "legacy"
  | "initialization"
  | "unavailable";

export function memoryStoreErrorKind(
  error: unknown,
  fallback: MemoryStoreErrorKind = "unavailable",
): MemoryStoreErrorKind {
  const message = (
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : ""
  ).toLowerCase();
  if (message.includes("key is missing")) return "missingKey";
  if (message.includes("keychain") || message.includes("locked"))
    return "keyUnavailable";
  if (
    message.includes("legacy") ||
    message.includes("requires explicit migration")
  )
    return "legacy";
  if (message.includes("not initialized")) return "initialization";
  return fallback;
}

export const memoryStoreErrorCopy: Record<MemoryStoreErrorKind, string> = {
  missingKey:
    "The encryption key for this memory store is missing. Existing memory has not been replaced. Restore access to the original key, then refresh.",
  keyUnavailable:
    "The memory encryption key is unavailable. Unlock or restore access to your system keychain, then refresh. Existing memory has not been replaced.",
  legacy:
    "This memory store needs an explicit migration before Berd can read it. Existing files have not been replaced. Plaintext files are not imported automatically.",
  initialization:
    "Couldn't initialize encrypted memory. Check access to your system keychain and memory folder, then try again. Existing memory has not been replaced.",
  unavailable:
    "Couldn't read encrypted memory. The store may be damaged or unavailable. Existing memory has not been replaced. Resolve the store problem, then refresh.",
};
