export function defaultExportFilename(title: string): string {
  const sanitized = title
    .trim()
    .replaceAll(/[<>:"/\\|?*]/g, "-")
    .replaceAll(/[\r\n\t]/g, "-")
    .split("")
    .map((char) => (char < " " ? "-" : char))
    .join("")
    .replace(/\s+/g, " ")
    .slice(0, 120);

  return `${sanitized || "session"}.json`;
}

export function exportFilenameFromPath(
  path: string,
  fallbackFilename: string,
): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const filename = normalized.split("/").pop();
  return filename?.trim() ? filename : fallbackFilename;
}

export function downloadJson(json: string, filename: string): void {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
