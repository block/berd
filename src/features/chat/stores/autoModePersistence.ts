const STORAGE_KEY = "goose:chat-auto-modes";

function readModes(): Record<string, string | null> {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "{}",
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        ([, mode]) =>
          mode === null || (typeof mode === "string" && mode.length > 0),
      ),
    );
  } catch {
    return {};
  }
}

/** Only selection intent is durable. Router responses remain session-local. */
export function loadAutoMode(sessionId: string): string | null | undefined {
  return readModes()[sessionId];
}

export function persistAutoMode(
  sessionId: string,
  modeId: string | null | undefined,
): void {
  try {
    const modes = readModes();
    if (modeId === undefined) delete modes[sessionId];
    else modes[sessionId] = modeId;
    if (Object.keys(modes).length)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(modes));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable.
  }
}
