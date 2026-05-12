export function isRemoteAvatarUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

export function isSupportedAvatarUrl(value: string): boolean {
  return isRemoteAvatarUrl(value);
}

export function normalizeAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return isSupportedAvatarUrl(trimmed) ? trimmed : undefined;
}
