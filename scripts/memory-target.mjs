// Only compile-target metadata is authoritative. Never inspect the build host,
// browser, or a VITE_* feature override here.
export const MEMORY_TARGET = "aarch64-apple-darwin";
export function isMemoryTargetSupported(env = {}) {
  if (env.TAURI_ENV_TARGET_TRIPLE !== undefined) {
    return env.TAURI_ENV_TARGET_TRIPLE === MEMORY_TARGET;
  }
  return (
    env.TAURI_ENV_PLATFORM === "darwin" && env.TAURI_ENV_ARCH === "aarch64"
  );
}

export function memoryExternalBin(externalBin, target, command = "build") {
  const retained = externalBin.filter(
    (entry) => !/(^|[/\\])berd-memory-mcp(?:[.-].*)?$/.test(entry),
  );
  if (target === MEMORY_TARGET && command === "build") {
    retained.push("binaries/berd-memory-mcp");
  }
  return retained;
}
