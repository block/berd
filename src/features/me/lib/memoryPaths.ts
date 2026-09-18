/** Match the backend's slash-separated logical paths, including on Windows. */
export function normalizeMemoryPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function memoryRootPath(homeDir: string): string {
  return `${normalizeMemoryPath(homeDir)}/.me`;
}
