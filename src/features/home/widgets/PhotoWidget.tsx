import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ImageOff, ImagePlus, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import type { PhotoShape, WidgetRenderProps } from "./types";
import { useWidgetActivationGuard } from "./useWidgetActivationGuard";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

const PHOTO_SHAPES: PhotoShape[] = ["original", "square", "circle"];
const PHOTO_ASPECT_RATIO_TIMEOUT_MS = 5_000;
const PHOTO_IMPORT_ERROR_KEYS = {
  importFailed: "widgets.photo.importFailed",
  notAFile: "widgets.photo.notAFile",
  readFailed: "widgets.photo.readFailed",
  tooLarge: "widgets.photo.tooLarge",
  unsupportedType: "widgets.photo.unsupportedType",
} as const;

type PhotoImportErrorCode = keyof typeof PHOTO_IMPORT_ERROR_KEYS;

function photoImportErrorCode(error: unknown): PhotoImportErrorCode {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "importFailed";
  }
  const code = error.code;
  return typeof code === "string" && code in PHOTO_IMPORT_ERROR_KEYS
    ? (code as PhotoImportErrorCode)
    : "importFailed";
}

export function photoShapeOf(state?: Record<string, unknown>): PhotoShape {
  switch (state?.shape) {
    case "square":
    case "circle":
      return state.shape;
    default:
      return "original";
  }
}

export function photoAspectRatioOf(state?: Record<string, unknown>): number {
  const value = state?.aspectRatio;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 4 / 3;
}

function photoPathOf(state?: Record<string, unknown>): string | null {
  return typeof state?.path === "string" && state.path.trim()
    ? state.path.trim()
    : null;
}

function nextPhotoShape(shape: PhotoShape): PhotoShape {
  const index = PHOTO_SHAPES.indexOf(shape);
  return PHOTO_SHAPES[(index + 1) % PHOTO_SHAPES.length] ?? "original";
}

function loadPhotoAspectRatio(src: string): Promise<number> {
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const finish = (aspectRatio: number) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
      resolve(aspectRatio);
    };
    const timeout = window.setTimeout(
      () => finish(4 / 3),
      PHOTO_ASPECT_RATIO_TIMEOUT_MS,
    );
    image.onload = () =>
      finish(
        image.naturalWidth > 0 && image.naturalHeight > 0
          ? image.naturalWidth / image.naturalHeight
          : 4 / 3,
      );
    image.onerror = () => finish(4 / 3);
    image.src = src;
  });
}

export function PhotoWidget({
  instance,
  onUpdateState,
  shouldIgnoreActivation,
}: WidgetRenderProps) {
  const { t } = useTranslation("home");
  const [selecting, setSelecting] = useState(false);
  const [unavailableImageSrc, setUnavailableImageSrc] = useState<string | null>(
    null,
  );
  const path = photoPathOf(instance.state);
  const shape = photoShapeOf(instance.state);
  const imageSrc = path ? convertFileSrc(path, "asset") : null;
  const imageUnavailable =
    imageSrc !== null && unavailableImageSrc === imageSrc;

  const choosePhoto = useWidgetActivationGuard(
    shouldIgnoreActivation,
    async () => {
      if (selecting) {
        return;
      }
      setSelecting(true);
      try {
        const selected = await open({
          title: t(
            path ? "widgets.photo.changeDialog" : "widgets.photo.chooseDialog",
          ),
          multiple: false,
          filters: [
            {
              name: t("widgets.photo.fileType"),
              extensions: ["avif", "gif", "jpeg", "jpg", "png", "webp"],
            },
          ],
        });
        if (typeof selected !== "string") {
          return;
        }
        const importedPath = await invoke<string>("import_home_widget_photo", {
          sourcePath: selected,
        });
        const aspectRatio = await loadPhotoAspectRatio(
          convertFileSrc(importedPath, "asset"),
        );
        setUnavailableImageSrc(null);
        onUpdateState({ path: importedPath, aspectRatio });
      } catch (error) {
        console.warn("Failed to import home widget photo", error);
        toast.error(t(PHOTO_IMPORT_ERROR_KEYS[photoImportErrorCode(error)]));
      } finally {
        setSelecting(false);
      }
    },
  );

  const cycleShape = useWidgetActivationGuard(shouldIgnoreActivation, () => {
    onUpdateState({ shape: nextPhotoShape(shape) });
  });

  if (imageUnavailable) {
    return (
      <button
        type="button"
        onClick={choosePhoto}
        disabled={selecting}
        className="group/photo flex h-full w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border bg-card text-center outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60"
      >
        <span className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors group-hover/photo:text-foreground">
          <ImageOff className="size-5" aria-hidden="true" />
        </span>
        <span className="space-y-1 px-5">
          <span className="block text-sm font-medium text-foreground">
            {t("widgets.photo.unavailable")}
          </span>
          <span className="block text-xs text-muted-foreground">
            {selecting
              ? t("widgets.photo.selecting")
              : t("widgets.photo.chooseAnother")}
          </span>
        </span>
      </button>
    );
  }

  if (!imageSrc) {
    return (
      <button
        type="button"
        onClick={choosePhoto}
        disabled={selecting}
        className="group/photo flex h-full w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border bg-card text-center outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60"
      >
        <span className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors group-hover/photo:text-foreground">
          <ImagePlus className="size-5" aria-hidden="true" />
        </span>
        <span className="space-y-1 px-5">
          <span className="block text-sm font-medium text-foreground">
            {selecting
              ? t("widgets.photo.selecting")
              : t("widgets.photo.addPhoto")}
          </span>
          <span className="block text-xs text-muted-foreground">
            {t("widgets.photo.addHint")}
          </span>
        </span>
      </button>
    );
  }

  return (
    <div className="group/photo relative h-full w-full">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={cycleShape}
            className={cn(
              "block h-full w-full cursor-pointer overflow-hidden bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring",
              shape === "circle" ? "rounded-full" : "rounded-md",
            )}
            aria-label={t("widgets.photo.shapeControl", {
              current: t(`widgets.photo.shapes.${shape}`),
              next: t(`widgets.photo.shapes.${nextPhotoShape(shape)}`),
            })}
          >
            <img
              src={imageSrc}
              alt={t("widgets.photo.imageAlt")}
              draggable={false}
              onLoad={(event) => {
                setUnavailableImageSrc(null);
                const { naturalWidth, naturalHeight } = event.currentTarget;
                if (naturalWidth <= 0 || naturalHeight <= 0) {
                  return;
                }
                const renderedAspectRatio = naturalWidth / naturalHeight;
                const persistedAspectRatio = photoAspectRatioOf(instance.state);
                if (
                  Math.abs(renderedAspectRatio - persistedAspectRatio) > 0.001
                ) {
                  onUpdateState({ aspectRatio: renderedAspectRatio });
                }
              }}
              onError={() => setUnavailableImageSrc(imageSrc)}
              className={cn(
                "pointer-events-none h-full w-full select-none",
                shape === "original" ? "object-contain" : "object-cover",
              )}
            />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" pointerEvents="none">
          {t("widgets.photo.clickToChangeShape")}
        </TooltipContent>
      </Tooltip>
      <div
        role="toolbar"
        aria-label={t("widgets.photo.toolbar")}
        className={cn(
          "pointer-events-none absolute left-1/2 top-0 z-40 flex w-max -translate-x-1/2 -translate-y-[calc(100%+0.625rem)] cursor-default items-center rounded-full border border-border/45 bg-card/45 px-2 py-1 text-foreground opacity-0 shadow-popover backdrop-blur-[2px] transition-opacity duration-150 after:absolute after:inset-x-0 after:top-full after:h-[0.625rem] after:content-['']",
          "group-hover/photo:pointer-events-auto group-hover/photo:opacity-100 group-focus-within/photo:pointer-events-auto group-focus-within/photo:opacity-100",
        )}
        onPointerDownCapture={(event) => event.stopPropagation()}
      >
        <Button
          type="button"
          variant="ghost"
          size="xs"
          leftIcon={
            <RefreshCw
              className={cn(selecting && "animate-spin")}
              aria-hidden="true"
            />
          }
          onClick={choosePhoto}
          disabled={selecting}
        >
          {t("widgets.photo.change")}
        </Button>
      </div>
    </div>
  );
}
