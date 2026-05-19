import {
  avatarAssetFormat,
  avatarModules,
} from "@/shared/avatars/catalog-assets";

export const APP_AVATAR_REF_PREFIX = "app-avatar:" as const;

export type AvatarMediaType = "image" | "video";
export type AvatarAssetFormat = "webm" | "hevc";

export interface AvatarCatalogEntry {
  id: string;
  label: string;
  src: string;
  mediaType: AvatarMediaType;
  collectionId: string;
}

export interface ResolvedAvatarMedia {
  src: string;
  mediaType: AvatarMediaType;
}

export interface AvatarCollection {
  id: string;
  label: string;
  coverAvatarId: string;
  avatarIds: string[];
}

const collectionLabels: Record<string, string> = {
  fuzzies: "Fuzzies",
  gloopies: "Gloopies",
  pollies: "Pollies",
};

export const avatarCatalogFormat: AvatarAssetFormat = avatarAssetFormat;

function mediaTypeFromPath(path: string): AvatarMediaType {
  return /\.(mov|mp4|webm)$/i.test(path) ? "video" : "image";
}

function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function labelFromId(id: string): string {
  return id
    .split(/[-_]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function buildAvatarCatalogFromModules(
  modules: Record<string, string>,
): AvatarCatalogEntry[] {
  return Object.entries(modules)
    .map(([path, src]) => {
      const match = path.match(
        /\/avatars\/(?:webm|hevc)\/([^/]+)\/([^/.]+)\.[^.]+$/,
      );
      if (!match) {
        return undefined;
      }

      const [, collectionId, id] = match;
      return {
        id,
        label: labelFromId(id),
        src,
        mediaType: mediaTypeFromPath(path),
        collectionId,
      } satisfies AvatarCatalogEntry;
    })
    .filter((entry): entry is AvatarCatalogEntry => Boolean(entry))
    .sort(
      (left, right) =>
        naturalCompare(left.collectionId, right.collectionId) ||
        naturalCompare(left.id, right.id),
    );
}

export const avatarCatalog = buildAvatarCatalogFromModules(avatarModules);

const avatarCatalogById = new Map(
  avatarCatalog.map((entry) => [entry.id, entry]),
);

function collectionForEntry(entry: AvatarCatalogEntry): AvatarCollection {
  return {
    id: entry.collectionId,
    label:
      collectionLabels[entry.collectionId] ?? labelFromId(entry.collectionId),
    coverAvatarId: entry.id,
    avatarIds: [],
  };
}

function buildAvatarCollections(
  entries: AvatarCatalogEntry[],
): AvatarCollection[] {
  const collectionsById: Record<string, AvatarCollection> = {};

  for (const entry of entries) {
    const collection =
      collectionsById[entry.collectionId] ?? collectionForEntry(entry);
    collection.avatarIds.push(entry.id);
    collectionsById[entry.collectionId] = collection;
  }

  return Object.values(collectionsById).sort((left, right) =>
    naturalCompare(left.label, right.label),
  );
}

export const avatarCollections = buildAvatarCollections(avatarCatalog);

export function avatarRef(id: string): string {
  return `${APP_AVATAR_REF_PREFIX}${id}`;
}

export function getAvatarCatalogEntry(
  id: string,
): AvatarCatalogEntry | undefined {
  return avatarCatalogById.get(id);
}

export function parseAvatarRef(value: string): string | undefined {
  if (!value.startsWith(APP_AVATAR_REF_PREFIX)) {
    return undefined;
  }

  const id = value.slice(APP_AVATAR_REF_PREFIX.length);
  return avatarCatalogById.has(id) ? id : undefined;
}

export function isBundledAvatarRef(value: string): boolean {
  return parseAvatarRef(value.trim()) !== undefined;
}

export function resolveBundledAvatarRef(value: string): string | undefined {
  const id = parseAvatarRef(value.trim());
  return id ? avatarCatalogById.get(id)?.src : undefined;
}

export function resolveBundledAvatarMedia(
  value: string,
): ResolvedAvatarMedia | undefined {
  const id = parseAvatarRef(value.trim());
  if (!id) {
    return undefined;
  }

  const entry = avatarCatalogById.get(id);
  return entry
    ? {
        src: entry.src,
        mediaType: entry.mediaType,
      }
    : undefined;
}
