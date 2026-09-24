/** Build-target capability, independent of user policy and experiments. */
export function isMemorySupported(): boolean {
  return import.meta.env.VITE_MEMORY_SUPPORTED === "1";
}

export function requireMemorySupported(): void {
  if (!isMemorySupported()) {
    throw new Error("Memory is unavailable on this build.");
  }
}
