import type { AvatarLibraryState } from "@/features/agents/hooks/useAvatarLibrary";
import {
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
  /** Full persisted ref; also the stable identity across avatar namespaces. */
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
  /** Cover presentation is independent from the ordered collection entries. */
  cover?: AvatarDisplayEntry;
  entries: AvatarDisplayEntry[];
}

function bundledEntry(
  library: AvatarLibraryState,
  avatarId: string,
): AvatarDisplayEntry | undefined {
  const entry = getAvatarCatalogEntry(library.catalog, avatarId);
  if (!entry) {
    return undefined;
  }
  const cachedMedia = library.cachedAvatarMediaById[avatarId];
  const catalogVersion = library.catalog?.catalogVersion;
  const fallbackVariant = entry.variants.webm ?? entry.variants.hevc;
  return {
    id: entry.id,
    ref: avatarRef(entry.id),
    label: entry.label,
    media:
      cachedMedia?.catalogVersion === catalogVersion
        ? cachedMedia.media
        : undefined,
    fallbackMediaType: fallbackVariant
      ? mediaTypeFromMimeType(fallbackVariant.mimeType)
      : "image",
    isUserAvatar: false,
  };
}

function userGloopieEntries(library: AvatarLibraryState): AvatarDisplayEntry[] {
  return library.userAvatarIds.map((avatarId) => ({
    id: avatarId,
    ref: userAvatarRef(avatarId),
    media: library.userAvatarMediaById[avatarId],
    fallbackMediaType: "video",
    isUserAvatar: true,
  }));
}

/**
 * Builds the single browsing model shared by the inline picker and full-screen
 * gallery. Custom gloopies are prepended to the existing Gloopies collection;
 * the newest custom gloopie also becomes that collection's cover. Other
 * collections retain their catalog-authored cover independently of tile order.
 */
export function buildAvatarDisplayCollections(
  library: AvatarLibraryState,
): AvatarDisplayCollection[] {
  const customGloopies = userGloopieEntries(library);

  return (library.catalog?.collections ?? []).map((collection) => {
    const bundledEntries = collection.avatarIds.flatMap((avatarId) => {
      const entry = bundledEntry(library, avatarId);
      return entry ? [entry] : [];
    });
    const catalogCover = bundledEntry(library, collection.coverAvatarId);
    const isGloopies = collection.id === GLOOPIES_COLLECTION_ID;

    return {
      id: collection.id,
      label: collection.label,
      cover: isGloopies ? (customGloopies[0] ?? catalogCover) : catalogCover,
      entries: isGloopies
        ? [...customGloopies, ...bundledEntries]
        : bundledEntries,
    };
  });
}
