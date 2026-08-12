import { ArrowLeft, Check, RefreshCw } from "lucide-react";
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
  disabled?: boolean;
  /**
   * When provided, the parent controls collection navigation and the picker's
   * internal back-to-collections row is suppressed (the parent is expected to
   * render its own back affordance, e.g. in a surrounding header).
   */
  selectedCollectionId?: string | null;
  onSelectCollection?: (collectionId: string | null) => void;
}

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

export function AvatarLibraryPicker({
  library,
  selectedAvatarRef,
  onSelectAvatar,
  onPreviewError,
  disabled = false,
  selectedCollectionId: controlledCollectionId,
  onSelectCollection,
}: AvatarLibraryPickerProps) {
  const { t } = useTranslation(["agents", "common"]);
  const isControlled = controlledCollectionId !== undefined;
  const [uncontrolledCollectionId, setUncontrolledCollectionId] = useState<
    string | null
  >(null);
  const selectedCollectionId = isControlled
    ? controlledCollectionId
    : uncontrolledCollectionId;
  const setSelectedCollectionId = useCallback(
    (next: string | null) => {
      if (isControlled) {
        onSelectCollection?.(next);
      } else {
        setUncontrolledCollectionId(next);
      }
    },
    [isControlled, onSelectCollection],
  );

  const avatarCollections = library.catalog?.collections ?? [];
  const selectedCollection = avatarCollections.find(
    (collection) => collection.id === selectedCollectionId,
  );
  const catalogErrorText =
    library.errorCode === "networkAccess"
      ? t("editor.avatarCatalogNetworkAccess")
      : t("editor.avatarCatalogUnavailable");
  const catalogVersion = library.catalog?.catalogVersion;
  const { cachedAvatarMediaById } = library;

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
      const selectable = Boolean(cachedMedia) && !disabled;

      return (
        <button
          key={entry.id}
          type="button"
          className={cn(
            "relative flex aspect-square min-h-24 items-center justify-center overflow-hidden rounded-sm bg-popover p-2",
            "border border-border/80 transition-colors hover:border-border",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            !selectable &&
              "cursor-not-allowed opacity-60 hover:border-border/80",
            selected && "border-ring ring-2 ring-ring/25",
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
              className="max-h-full max-w-full object-contain"
              onError={onPreviewError}
            />
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
            <span className="absolute right-2 top-2 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Check className="size-3" />
            </span>
          ) : null}
        </button>
      );
    },
    [
      cachedAvatarMediaById,
      catalogVersion,
      disabled,
      onPreviewError,
      onSelectAvatar,
      selectedAvatarRef,
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

      return (
        <button
          key={collection.id}
          type="button"
          className={cn(
            "flex w-full items-center gap-4 rounded-xl bg-popover p-4 text-left",
            "border border-border/80 transition-colors hover:border-border hover:bg-accent",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            disabled && "cursor-not-allowed opacity-60",
          )}
          disabled={disabled}
          onClick={() => setSelectedCollectionId(collection.id)}
        >
          <span className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/40">
            {cachedCoverMedia ? (
              <AvatarMedia
                media={cachedCoverMedia}
                alt=""
                loadingStrategy="visible-video"
                className="h-full w-full object-contain p-1"
                onError={onPreviewError}
              />
            ) : (
              <span className="text-xs text-muted-foreground">
                {collection.label}
              </span>
            )}
          </span>
          <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
            <span className="truncate text-base text-foreground">
              {collection.label}
            </span>
            {cachedCoverMedia ? (
              <Check className="size-4 shrink-0 text-muted-foreground" />
            ) : library.mediaError ? (
              <RefreshCw className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <Spinner className="size-4 shrink-0 text-muted-foreground" />
            )}
          </span>
        </button>
      );
    },
    [
      cachedAvatarMediaById,
      catalogVersion,
      disabled,
      library,
      onPreviewError,
      setSelectedCollectionId,
    ],
  );

  const renderCollectionSkeleton = (index: number) => (
    <div
      key={index}
      className="flex w-full items-center gap-4 rounded-xl bg-popover p-4"
    >
      <span className="flex size-14 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
        <Spinner className="size-4 text-muted-foreground" />
      </span>
      <span className="text-sm text-muted-foreground">
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
        <div className="flex items-center justify-between gap-2 rounded-sm bg-popover px-3 py-2 text-[11px] text-muted-foreground">
          <span>{catalogErrorText}</span>
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
      ) : library.mediaError ? (
        <div className="flex items-center justify-between gap-2 rounded-sm bg-popover px-3 py-2 text-[11px] text-muted-foreground">
          <span>{t("avatar.loadFailed")}</span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={library.cacheChecking}
            onClick={library.retryMedia}
          >
            <RefreshCw className="size-3" />
            {t("editor.avatarRetry")}
          </Button>
        </div>
      ) : null}
      {selectedCollection ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          {isControlled ? null : (
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
          )}
          <div className="grid min-h-0 flex-1 grid-cols-3 gap-2 overflow-y-auto pr-1">
            {selectedCollection.avatarIds.map((avatarId) => {
              const entry = getAvatarCatalogEntry(library.catalog, avatarId);
              return entry ? renderAvatarTile(entry) : null;
            })}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {library.loading && avatarCollections.length === 0
            ? [0, 1, 2].map(renderCollectionSkeleton)
            : avatarCollections.map(renderCollectionButton)}
        </div>
      )}
    </div>
  );
}
