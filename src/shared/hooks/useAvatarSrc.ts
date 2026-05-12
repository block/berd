import { useMemo } from "react";
import { normalizeAvatarUrl } from "@/shared/lib/avatarUrl";
import type { Avatar } from "@/shared/types/agents";

/**
 * React hook that resolves an Avatar to a displayable image URL.
 */
export function useAvatarSrc(
  avatar: Avatar | null | undefined,
): string | undefined {
  return useMemo(() => normalizeAvatarUrl(avatar), [avatar]);
}
