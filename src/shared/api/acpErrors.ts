function getErrorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error.trim();
  }

  if (error instanceof Error) {
    return error.message.trim();
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message.trim();
  }

  return "";
}

function stringifyData(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

export function formatAcpErrorMessage(
  error: unknown,
  fallback = "Unknown error",
): string {
  const message = getErrorMessage(error);
  if (typeof error === "object" && error !== null && "data" in error) {
    const data = error.data;
    if (typeof data === "string") {
      const detail = data.trim();
      if (detail) {
        return detail;
      }
    } else if (data !== undefined && data !== null) {
      return `${message || String(error)}: ${stringifyData(data)}`;
    }
  }

  return message || fallback;
}

// Match "provider not set" only where "set" is the complete trailing word, not
// the start of a phrase like "provider not set up correctly". The `\b` rejects
// "set"-prefixed words (e.g. "settings") and the negative lookahead rejects the
// "set up" case a plain substring match would otherwise accept — a false
// positive here silently discards the current session onto a fresh one.
const PROVIDER_NOT_SET_PATTERN = /provider not set\b(?!\s+up\b)/i;

/**
 * True when an ACP error indicates the session's live provider is unset. Goose
 * reports this as `"Provider not set"`, usually wrapped as
 * `"Failed to get provider: Provider not set"`, when a provider failed to
 * construct (e.g. the default databricks provider on a machine with no Block
 * auth). Provider and model switches read the current provider before applying
 * a change, so a stranded session reports this for every switch attempt — the
 * signal callers use to recover by recreating the session on a fresh provider
 * rather than reconfiguring the dead one in place.
 */
export function isProviderNotSetError(error: unknown): boolean {
  return PROVIDER_NOT_SET_PATTERN.test(formatAcpErrorMessage(error, ""));
}
