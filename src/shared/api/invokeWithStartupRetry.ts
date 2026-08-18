import { invoke } from "@tauri-apps/api/core";

// During first launch the renderer can race ahead of the Tauri `setup()`
// closure: the hidden-but-loaded webview issues commands on Tokio threads
// before `app.manage(...)` has registered the command's state. Those calls
// reject with "state not managed" / "not registered" for a brief startup
// window, then succeed once setup catches up. Treat only those messages as a
// transient condition and retry with bounded backoff; every other rejection
// is a genuine error and propagates immediately.
const TRANSIENT_STATE_ERROR_PATTERN = /state not managed|not registered/i;
const MAX_STARTUP_RETRIES = 5;
const STARTUP_RETRY_BASE_DELAY_MS = 100;

function isTransientStateError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT_STATE_ERROR_PATTERN.test(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function invokeWithStartupRetry<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return args === undefined
        ? await invoke<T>(command)
        : await invoke<T>(command, args);
    } catch (error) {
      if (attempt >= MAX_STARTUP_RETRIES || !isTransientStateError(error)) {
        throw error;
      }
      await delay(STARTUP_RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }
}
