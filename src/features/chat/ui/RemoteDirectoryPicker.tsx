import { useCallback, useEffect, useRef, useState } from "react";
import { CornerLeftUp, Folder, FolderOpen, History } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  isRemoteBackendError,
  listRemoteDirs,
  type RemoteBackendErrorLike,
  type RemoteDirListing,
} from "@/shared/api/remoteHosts";
import { useRemoteHostStore } from "@/features/remoteHosts/stores/remoteHostStore";
import { Button } from "@/shared/ui/button";
import { ComposerActionButton } from "@/shared/ui/composer-action-button";
import { Input } from "@/shared/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { RowButton } from "@/shared/ui/row-button";

interface RemoteDirectoryPickerProps {
  host: string;
  selectedDir?: string | null;
  onDirChange?: (dir: string | null) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  triggerIconOnly?: boolean;
}

function toErrorLike(error: unknown): RemoteBackendErrorLike {
  if (isRemoteBackendError(error)) return error;
  return {
    kind: "internal",
    message: error instanceof Error ? error.message : String(error),
  };
}

/** Last path segment for the trigger label; "/" and "~" name themselves. */
function directoryBasename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (!trimmed) return "/";
  const index = trimmed.lastIndexOf("/");
  return index >= 0 ? trimmed.slice(index + 1) || "/" : trimmed;
}

/** Parent of a resolved absolute path, or null at the filesystem root. */
function parentDirectory(path: string): string | null {
  const trimmed = path.replace(/\/+$/, "");
  if (!trimmed.includes("/")) return null;
  const parent = trimmed.slice(0, trimmed.lastIndexOf("/"));
  return parent || "/";
}

export function RemoteDirectoryPicker({
  host,
  selectedDir = null,
  onDirChange,
  open,
  onOpenChange,
  disabled,
  triggerIconOnly = false,
}: RemoteDirectoryPickerProps) {
  const { t } = useTranslation("chat");
  const recentDirs = useRemoteHostStore(
    (state) => state.recentDirsByHost[host],
  );
  const [pathInput, setPathInput] = useState(selectedDir ?? "~");
  const [listing, setListing] = useState<RemoteDirListing | null>(null);
  const [error, setError] = useState<RemoteBackendErrorLike | null>(null);
  const [loading, setLoading] = useState(false);
  const requestIdRef = useRef(0);
  const selectedDirRef = useRef(selectedDir);
  selectedDirRef.current = selectedDir;

  const browse = useCallback(
    async (path: string) => {
      const requestId = ++requestIdRef.current;
      setLoading(true);
      setError(null);
      try {
        const result = await listRemoteDirs(host, path);
        if (requestIdRef.current !== requestId) return;
        setListing(result);
        setPathInput(result.resolvedPath);
      } catch (browseError) {
        if (requestIdRef.current !== requestId) return;
        setError(toErrorLike(browseError));
      } finally {
        if (requestIdRef.current === requestId) {
          setLoading(false);
        }
      }
    },
    [host],
  );

  useEffect(() => {
    if (!open) return;
    void browse(selectedDirRef.current ?? "~");
  }, [open, browse]);

  const directories = (listing?.entries ?? []).filter((entry) => entry.isDir);
  const parentPath = listing ? parentDirectory(listing.resolvedPath) : null;
  const triggerLabel = selectedDir
    ? directoryBasename(selectedDir)
    : t("toolbar.remoteHost.directory.chooseFolder");

  const confirmDirectory = () => {
    if (!listing) return;
    onDirChange?.(listing.resolvedPath);
    useRemoteHostStore.getState().recordRecentDir(host, listing.resolvedPath);
    onOpenChange?.(false);
  };

  return (
    <Popover modal={false} open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <ComposerActionButton
          type="button"
          size={triggerIconOnly ? "icon-pill-sm" : "sm"}
          disabled={disabled}
          aria-label={t("toolbar.remoteHost.directory.selectDirectory")}
          leftIcon={<FolderOpen />}
          title={selectedDir ?? undefined}
          className={
            triggerIconOnly
              ? "shrink-0"
              : "chat-composer-selector-trigger max-w-40 min-w-0"
          }
        >
          {triggerIconOnly ? null : (
            <span className="chat-composer-selector-label truncate">
              {triggerLabel}
            </span>
          )}
        </ComposerActionButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-3">
        <div className="mb-2 text-sm font-semibold text-foreground">
          {t("toolbar.remoteHost.directory.title", { host })}
        </div>
        <form
          className="mb-2"
          onSubmit={(event) => {
            event.preventDefault();
            void browse(pathInput);
          }}
        >
          <Input
            value={pathInput}
            onChange={(event) => setPathInput(event.target.value)}
            placeholder={t("toolbar.remoteHost.directory.pathPlaceholder")}
            aria-label={t("toolbar.remoteHost.directory.pathLabel")}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
        </form>
        {error ? (
          <p className="mb-2 text-xs text-destructive" role="alert">
            {error.message}
          </p>
        ) : null}
        <div className="scrollbar-subtle max-h-56 space-y-0.5 overflow-y-auto">
          {parentPath ? (
            <RowButton
              icon={
                <CornerLeftUp className="size-4 shrink-0 text-muted-foreground" />
              }
              label={t("toolbar.remoteHost.directory.parent")}
              onClick={() => void browse(parentPath)}
              disabled={loading}
            />
          ) : null}
          {directories.map((entry) => (
            <RowButton
              key={entry.name}
              icon={
                <Folder className="size-4 shrink-0 text-muted-foreground" />
              }
              label={entry.name}
              onClick={() =>
                listing &&
                void browse(
                  `${listing.resolvedPath.replace(/\/+$/, "")}/${entry.name}`,
                )
              }
              disabled={loading}
            />
          ))}
          {!loading && listing && directories.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              {t("toolbar.remoteHost.directory.empty")}
            </p>
          ) : null}
          {loading ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              {t("toolbar.remoteHost.directory.loading")}
            </p>
          ) : null}
        </div>
        {recentDirs?.length ? (
          <div className="mt-2 border-t border-border pt-2">
            <div className="px-2 pb-1 text-xs font-medium text-muted-foreground">
              {t("toolbar.remoteHost.directory.recents")}
            </div>
            <div className="space-y-0.5">
              {recentDirs.map((dir) => (
                <RowButton
                  key={dir}
                  icon={
                    <History className="size-4 shrink-0 text-muted-foreground" />
                  }
                  label={dir}
                  onClick={() => void browse(dir)}
                  disabled={loading}
                />
              ))}
            </div>
          </div>
        ) : null}
        <div className="mt-3">
          <Button
            type="button"
            size="sm"
            className="w-full"
            onClick={confirmDirectory}
            disabled={!listing || loading}
          >
            {t("toolbar.remoteHost.directory.use")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
