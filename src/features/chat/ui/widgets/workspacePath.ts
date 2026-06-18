export function shortenPath(fullPath: string): string {
  const home =
    typeof window !== "undefined"
      ? fullPath.replace(/^\/Users\/[^/]+/, "~")
      : fullPath;
  const parts = home.split("/");
  if (parts.length > 3) {
    return `\u2026/${parts.slice(-2).join("/")}`;
  }
  return home;
}
