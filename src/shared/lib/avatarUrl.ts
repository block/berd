import {
  isBundledAvatarRef,
  resolveBundledAvatarMedia,
  resolveBundledAvatarRef,
} from "@/shared/avatars/catalog";
import type { ResolvedAvatarMedia } from "@/shared/avatars/catalog";

function decodePathLikeValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function hasTraversalSegment(value: string): boolean {
  return decodePathLikeValue(value)
    .split(/[\\/]/)
    .some((segment) => segment === "..");
}

export function isRemoteAvatarUrl(value: string): boolean {
  const trimmed = value.trim();

  // Guard non-URL path-like inputs before URL parsing normalizes them.
  if (hasTraversalSegment(trimmed)) {
    return false;
  }

  try {
    const url = new URL(trimmed);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      !hasTraversalSegment(url.pathname)
    );
  } catch {
    return false;
  }
}

export function isSupportedAvatarRef(value: string): boolean {
  return isRemoteAvatarUrl(value) || isBundledAvatarRef(value);
}

export function normalizeAvatarRef(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return isSupportedAvatarRef(trimmed) ? trimmed : undefined;
}

export function resolveAvatarSrc(value: unknown): string | undefined {
  const normalized = normalizeAvatarRef(value);
  if (!normalized) {
    return undefined;
  }

  return resolveBundledAvatarRef(normalized) ?? normalized;
}

export function resolveAvatarMedia(
  value: unknown,
): ResolvedAvatarMedia | undefined {
  const normalized = normalizeAvatarRef(value);
  if (!normalized) {
    return undefined;
  }

  return (
    resolveBundledAvatarMedia(normalized) ?? {
      src: normalized,
      mediaType: "image",
    }
  );
}

export const isSupportedAvatarUrl = isSupportedAvatarRef;
export const normalizeAvatarUrl = normalizeAvatarRef;
