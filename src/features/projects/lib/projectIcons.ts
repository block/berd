export const DEFAULT_PROJECT_ICON = "tabler:folder-code";

export function normalizeProjectIcon(icon: string | null | undefined): string {
  if (!icon || icon === "\u{1F4C1}") {
    return DEFAULT_PROJECT_ICON;
  }

  if (isImageProjectIcon(icon)) {
    return icon;
  }

  return DEFAULT_PROJECT_ICON;
}

export function isFileProjectIcon(icon: string): boolean {
  return icon.startsWith("file:");
}

export function isImageProjectIcon(icon: string): boolean {
  return icon.startsWith("data:image/") || isFileProjectIcon(icon);
}

export function fileProjectIconValue(path: string): string {
  return `file:${path}`;
}
