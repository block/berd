import { ArrowLeft, Check, Download, RefreshCw } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  avatarRef,
  getAvatarCatalogEntry,
  mediaTypeFromMimeType,
} from "@/shared/avatars/catalog";
import type {
  AvatarCatalogEntry,
  AvatarCollection,
} from "@/shared/avatars/catalog";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { AvatarMedia } from "@/shared/ui/avatar-media";
import { Spinner } from "@/shared/ui/spinner";
import type { AvatarLibraryState } from "@/features/agents/hooks/useAvatarLibrary";

interface AvatarLibraryPickerProps {
  library: AvatarLibraryState;
  selectedAvatarRef: string | null;
  onSelectAvatar: (avatarId: string) => void;
  onPreviewError: () => void;
}

function getCachedAvatarMedia(
  cachedAvatarMediaById: AvatarLibraryState["cachedAvatarMediaById"],
  catalogVersion: string | undefined,
  avatarId: string,
) {
  const cachedMediaEntry = cachedAvatarMediaById[avatarId];
  return cachedMediaEntry?.catalogVersion === catalogVersion
    ? cachedMediaEntry.media
    : undefined;
}

export function AvatarLibraryPicker({
  library,
  selectedAvatarRef,
  onSelectAvatar,
  onPreviewError,
}: AvatarLibraryPickerProps) {
  const { t } = useTranslation(["agents", "common"]);
  const [selectedCollectionId, setSelectedCollectionId] = useState<
    string | null
  >(null);

  const avatarCollections = library.catalog?.collections ?? [];
  const selectedCollection = avatarCollections.find(
    (collection) => collection.id === selectedCollectionId,
  );
  const catalogVersion = library.catalog?.catalogVersion;
  const { cachedAvatarMediaById, downloadingCollectionId } = library;

  const renderAvatarTile = useCallback(
    (entry: AvatarCatalogEntry) => {
      const ref = avatarRef(entry.id);
      const selected = selectedAvatarRef === ref;
      const cachedMedia = getCachedAvatarMedia(
        cachedAvatarMediaById,
        catalogVersion,
        entry.id,
      );
      const fallbackVariant = entry.variants.webm ?? entry.variants.hevc;
      const fallbackMediaType = fallbackVariant
        ? mediaTypeFromMimeType(fallbackVariant.mimeType)
        : "image";
      const collectionDownloading =
        downloadingCollectionId === entry.collectionId;
      const selectable = Boolean(cachedMedia);

      return (
        <button
          key={entry.id}
          type="button"
          className={cn(
            "relative flex aspect-square min-h-24 items-center justify-center overflow-hidden rounded-card-sm bg-surface-overlay p-2",
            "border border-border-soft transition-colors hover:border-border",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-focus",
            !selectable &&
              "cursor-not-allowed opacity-60 hover:border-border-soft",
            selected && "border-border-focus ring-2 ring-ring-focus/25",
          )}
          aria-label={entry.label}
          aria-pressed={selected}
          aria-disabled={!selectable}
          disabled={!selectable}
          onClick={() => onSelectAvatar(entry.id)}
        >
          {cachedMedia ? (
            <AvatarMedia
              media={cachedMedia}
              alt=""
              lazy
              loadingStrategy="visible-video"
              playback="always"
              className="max-h-full max-w-full object-contain"
              onError={onPreviewError}
            />
          ) : collectionDownloading ? (
            <span className="flex flex-col items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-4" />
              {t("editor.avatarDownloading")}
            </span>
          ) : (
            <span
              className={cn(
                "text-center text-xs text-muted-foreground",
                fallbackMediaType === "video" && "italic",
              )}
            >
              {entry.label}
            </span>
          )}
          {selected ? (
            <span className="absolute right-2 top-2 flex size-5 items-center justify-center rounded-full bg-background-primary text-text-on-primary">
              <Check className="size-3" />
            </span>
          ) : null}
        </button>
      );
    },
    [
      cachedAvatarMediaById,
      catalogVersion,
      downloadingCollectionId,
      onPreviewError,
      onSelectAvatar,
      selectedAvatarRef,
      t,
    ],
  );

  const renderCollectionButton = useCallback(
    (collection: AvatarCollection) => {
      const cover = getAvatarCatalogEntry(
        library.catalog,
        collection.coverAvatarId,
      );
      if (!cover) {
        return null;
      }
      const cachedCoverMedia = getCachedAvatarMedia(
        cachedAvatarMediaById,
        catalogVersion,
        cover.id,
      );
      const collectionCached = library.isCollectionCached(collection);
      const collectionDownloading =
        library.downloadingCollectionId === collection.id;
      const collectionFailed = library.failedCollectionIds.has(collection.id);
      const statusText = collectionDownloading
        ? t("editor.avatarDownloading")
        : collectionFailed
          ? t("editor.avatarRetry")
          : collectionCached
            ? t("editor.avatarDownloaded")
            : library.cacheChecking
              ? t("editor.avatarLoading")
              : t("editor.avatarDownloadCollection", {
                  count: collection.avatarIds.length,
                });
      const StatusIcon = collectionFailed
        ? RefreshCw
        : collectionCached
          ? Check
          : Download;

      return (
        <button
          key={collection.id}
          type="button"
          className={cn(
            "flex min-w-0 flex-col items-center gap-2 rounded-card-sm bg-surface-overlay p-3 text-center",
            "border border-border-soft transition-colors hover:border-border hover:bg-background-hover",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-focus",
          )}
          onClick={() => {
            setSelectedCollectionId(collection.id);
            void library.openCollection(collection);
          }}
        >
          <span className="flex aspect-[4/3] w-full shrink-0 items-center justify-center overflow-hidden rounded-card-sm bg-background">
            {cachedCoverMedia ? (
              <AvatarMedia
                media={cachedCoverMedia}
                alt=""
                loadingStrategy="visible-video"
                playback="always"
                className="h-full w-full object-contain p-1"
                onError={onPreviewError}
              />
            ) : (
              <span className="text-xs text-muted-foreground">
                {collection.label}
              </span>
            )}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-xs text-foreground">
              {collection.label}
            </span>
            <span className="inline-flex items-center justify-center gap-1 text-[11px] text-muted-foreground">
              {collectionDownloading || library.cacheChecking ? (
                <Spinner className="size-3" />
              ) : (
                <StatusIcon className="size-3" />
              )}
              {statusText}
            </span>
          </span>
        </button>
      );
    },
    [cachedAvatarMediaById, catalogVersion, library, onPreviewError, t],
  );

  const renderCollectionSkeleton = (index: number) => (
    <div
      key={index}
      className="flex min-w-0 flex-col items-center gap-2 rounded-card-sm bg-surface-overlay p-3 text-center"
    >
      <span className="flex aspect-[4/3] w-full shrink-0 items-center justify-center rounded-card-sm bg-background">
        <Spinner className="size-4 text-muted-foreground" />
      </span>
      <span className="text-[11px] text-muted-foreground">
        {t("editor.avatarLoading")}
      </span>
    </div>
  );

  return (
    <div
      className={cn(
        "space-y-2",
        selectedCollection && "flex min-h-[18rem] flex-col gap-2 space-y-0",
      )}
    >
      {library.error ? (
        <div className="flex items-center justify-between gap-2 rounded-card-sm bg-surface-overlay px-3 py-2 text-[11px] text-muted-foreground">
          <span>{t("editor.avatarCatalogUnavailable")}</span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={library.retryCatalog}
          >
            <RefreshCw className="size-3" />
            {t("editor.avatarRetry")}
          </Button>
        </div>
      ) : null}
      {selectedCollection ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("editor.avatarBackToCollections")}
              onClick={() => setSelectedCollectionId(null)}
            >
              <ArrowLeft className="size-3.5" />
            </Button>
            <p className="text-xs text-foreground">
              {selectedCollection.label}
            </p>
          </div>
          {library.failedCollectionIds.has(selectedCollection.id) ? (
            <div className="flex items-center justify-between gap-2 rounded-card-sm bg-surface-overlay px-3 py-2 text-[11px] text-muted-foreground">
              <span>{t("avatar.loadFailed")}</span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => void library.openCollection(selectedCollection)}
              >
                <RefreshCw className="size-3" />
                {t("editor.avatarRetry")}
              </Button>
            </div>
          ) : null}
          <div className="grid min-h-0 flex-1 grid-cols-3 gap-2 overflow-y-auto pr-1">
            {selectedCollection.avatarIds.map((avatarId) => {
              const entry = getAvatarCatalogEntry(library.catalog, avatarId);
              return entry ? renderAvatarTile(entry) : null;
            })}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {library.loading && avatarCollections.length === 0
            ? [0, 1, 2].map(renderCollectionSkeleton)
            : avatarCollections.map(renderCollectionButton)}
        </div>
      )}
    </div>
  );
}
