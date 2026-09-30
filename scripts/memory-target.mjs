// A build host, TAURI_ENV_PLATFORM/ARCH, or a VITE_* override is never a
// compile target. The Tauri wrapper sets this triple for both Tauri and Vite.
export const MEMORY_TARGET = "aarch64-apple-darwin";
export const MEMORY_BIN = "binaries/berd-memory-mcp";

export function isMemoryTargetSupported(env = {}) {
  return env.TAURI_ENV_TARGET_TRIPLE === MEMORY_TARGET;
}

export function isMemorySidecar(entry) {
  return /(^|[/\\])berd-memory-mcp(?:[.-].*)?$/.test(entry);
}

export function memoryExternalBin(externalBin, target, command = "build") {
  if (
    !Array.isArray(externalBin) ||
    externalBin.some((entry) => typeof entry !== "string")
  ) {
    throw new TypeError("Tauri bundle.externalBin must be an array of strings");
  }
  const retained = externalBin.filter((entry) => !isMemorySidecar(entry));
  if (target === MEMORY_TARGET && command === "build")
    retained.push(MEMORY_BIN);
  return retained;
}
