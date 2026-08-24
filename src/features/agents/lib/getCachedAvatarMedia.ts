import type { AvatarLibraryState } from "@/features/agents/hooks/useAvatarLibrary";

export function getCachedAvatarMedia(
  cachedAvatarMediaById: AvatarLibraryState["cachedAvatarMediaById"],
  catalogVersion: string | undefined,
  avatarId: string,
) {
  const cachedMediaEntry = cachedAvatarMediaById[avatarId];
  return cachedMediaEntry?.catalogVersion === catalogVersion
    ? cachedMediaEntry.media
    : undefined;
}
