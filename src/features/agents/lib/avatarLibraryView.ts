import type { AvatarLibraryState } from "@/features/agents/hooks/useAvatarLibrary";
import {
  USER_AVATAR_CATALOG_VERSION,
  avatarRef,
  getAvatarCatalogEntry,
  mediaTypeFromMimeType,
  userAvatarRef,
} from "@/shared/avatars/catalog";
import type {
  AvatarMediaType,
  ResolvedAvatarMedia,
} from "@/shared/avatars/catalog";

const GLOOPIES_COLLECTION_ID = "gloopies";

/** One selectable avatar in a browsing surface. */
export interface AvatarDisplayEntry {
  id: string;
  ref: string;
  label?: string;
  media?: ResolvedAvatarMedia;
  /** Media type of the source asset even when the media is not cached yet. */
  fallbackMediaType: AvatarMediaType;
  /** Custom gloopies have no catalog-authored label. */
  isUserAvatar: boolean;
}

/** One collection in a browsing surface. */
export interface AvatarDisplayCollection {
  id: string;
  label?: string;
  entries: AvatarDisplayEntry[];
}

function cachedMedia(
  library: AvatarLibraryState,
  expectedCatalogVersion: string | undefined,
  avatarId: string,
): ResolvedAvatarMedia | undefined {
  const entry = library.cachedAvatarMediaById[avatarId];
  return entry?.catalogVersion === expectedCatalogVersion
    ? entry.media
    : undefined;
}

function userGloopieEntries(library: AvatarLibraryState): AvatarDisplayEntry[] {
  return library.userAvatarIds.map((avatarId) => ({
    id: avatarId,
    ref: userAvatarRef(avatarId),
    media: cachedMedia(library, USER_AVATAR_CATALOG_VERSION, avatarId),
    fallbackMediaType: "video",
    isUserAvatar: true,
  }));
}

/**
 * Builds the single browsing model shared by the inline picker and full-screen
 * gallery. Custom gloopies are prepended to the existing Gloopies collection;
 * they remain a separate local storage source and are never written into the
 * published catalog.
 */
export function buildAvatarDisplayCollections(
  library: AvatarLibraryState,
): AvatarDisplayCollection[] {
  const catalogVersion = library.catalog?.catalogVersion;
  const customGloopies = userGloopieEntries(library);

  return (library.catalog?.collections ?? []).map((collection) => {
    const bundledEntries = collection.avatarIds.flatMap((avatarId) => {
      const entry = getAvatarCatalogEntry(library.catalog, avatarId);
      if (!entry) {
        return [];
      }
      const fallbackVariant = entry.variants.webm ?? entry.variants.hevc;
      return [
        {
          id: entry.id,
          ref: avatarRef(entry.id),
          label: entry.label,
          media: cachedMedia(library, catalogVersion, entry.id),
          fallbackMediaType: fallbackVariant
            ? mediaTypeFromMimeType(fallbackVariant.mimeType)
            : "image",
          isUserAvatar: false,
        },
      ];
    });

    return {
      id: collection.id,
      label: collection.label,
      entries:
        collection.id === GLOOPIES_COLLECTION_ID
          ? [...customGloopies, ...bundledEntries]
          : bundledEntries,
    };
  });
}
