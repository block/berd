import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { ResolvedAvatarMedia } from "@/shared/avatars/catalog";
import { AvatarMedia } from "@/shared/ui/avatar-media";

interface StaticFrameEntry {
  status: "loading" | "ready" | "failed";
  failures: number;
  owner?: symbol;
  src?: string;
}

const THUMBNAIL_SIZE = 128;
const MAX_CAPTURE_FAILURES = 2;
const DECODER_TIMEOUT_MS = 8_000;
const staticFrameEntries = new Map<string, StaticFrameEntry>();
const staticFrameListeners = new Map<string, Set<() => void>>();

function staticFrameKey(media: ResolvedAvatarMedia): string {
  return `${media.src}:${media.alphaMode ?? "opaque"}`;
}

function emitStaticFrameChange(key: string) {
  for (const listener of staticFrameListeners.get(key) ?? []) listener();
}

function subscribeToStaticFrame(key: string, listener: () => void) {
  const listeners = staticFrameListeners.get(key) ?? new Set<() => void>();
  listeners.add(listener);
  staticFrameListeners.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) staticFrameListeners.delete(key);
  };
}

function captureRenderedFrame(host: HTMLElement): string | null {
  const source = host.querySelector("canvas, video");
  if (
    !(source instanceof HTMLCanvasElement) &&
    !(source instanceof HTMLVideoElement)
  ) {
    return null;
  }

  const sourceWidth =
    source instanceof HTMLCanvasElement ? source.width : source.videoWidth;
  const sourceHeight =
    source instanceof HTMLCanvasElement ? source.height : source.videoHeight;
  if (sourceWidth === 0 || sourceHeight === 0) return null;

  if (source instanceof HTMLCanvasElement) {
    const context = source.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    const pixels = context.getImageData(0, 0, sourceWidth, sourceHeight).data;
    let visiblePixels = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] > 8) visiblePixels += 1;
    }
    if (visiblePixels < sourceWidth) return null;

    // Stacked-alpha media is already composited into this canvas by
    // AvatarMedia. Copying it through a second canvas intermittently loses
    // the painted frame in macOS WebKit, so serialize the proven source.
    return source.toDataURL("image/png");
  }

  const canvas = document.createElement("canvas");
  canvas.width = THUMBNAIL_SIZE;
  canvas.height = THUMBNAIL_SIZE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(
    source,
    0,
    0,
    sourceWidth,
    sourceHeight,
    0,
    0,
    THUMBNAIL_SIZE,
    THUMBNAIL_SIZE,
  );
  const pixels = context.getImageData(
    0,
    0,
    THUMBNAIL_SIZE,
    THUMBNAIL_SIZE,
  ).data;
  let visiblePixels = 0;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] > 8) visiblePixels += 1;
  }
  if (visiblePixels < THUMBNAIL_SIZE) return null;
  return canvas.toDataURL("image/png");
}

function afterAnimationFrame(): Promise<void> {
  return new Promise((resolve) =>
    window.requestAnimationFrame(() => resolve()),
  );
}

async function captureAfterPaint(host: HTMLElement): Promise<string | null> {
  // WebKit can report decoded media before the canvas write is visible to a
  // second canvas. Give the compositor several frames, rejecting transparent
  // reads rather than permanently caching them as successful thumbnails.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await afterAnimationFrame();
    const src = captureRenderedFrame(host);
    if (src) return src;
  }
  return null;
}

/**
 * Renders video-only avatar media through one connected decoder, captures its
 * already-composited first visible frame, and reuses that image for every
 * compact occurrence. WebKit does not reliably decode Tauri asset URLs in
 * detached video elements, so one mounted occurrence owns decoding while all
 * others show their fixed-size fallback. Ownership transfers after remounts,
 * failures, and timeouts without creating concurrent decoders.
 */
export function AvatarStaticMedia({
  media,
  alt = "",
  className,
  fallback = null,
}: {
  media: ResolvedAvatarMedia;
  alt?: string;
  className?: string;
  fallback?: ReactNode;
}) {
  const key = staticFrameKey(media);
  const ownerRef = useRef(Symbol(key));
  const hostRef = useRef<HTMLSpanElement>(null);
  const entry = useSyncExternalStore(
    (listener) => subscribeToStaticFrame(key, listener),
    () => staticFrameEntries.get(key),
    () => undefined,
  );

  // Claim only after render. Every follower reruns when the shared entry
  // becomes claimable; the current map value is checked again so the first
  // effect to claim remains the sole decoder owner.
  useEffect(() => {
    const current = staticFrameEntries.get(key);
    if (
      current?.status === "loading" ||
      current?.status === "ready" ||
      (current?.failures ?? 0) >= MAX_CAPTURE_FAILURES
    ) {
      return;
    }
    staticFrameEntries.set(key, {
      status: "loading",
      failures: current?.failures ?? 0,
      owner: ownerRef.current,
    });
    emitStaticFrameChange(key);
  }, [entry?.failures, entry?.status, key]);

  useEffect(
    () => () => {
      const current = staticFrameEntries.get(key);
      if (current?.status === "loading" && current.owner === ownerRef.current) {
        staticFrameEntries.set(key, {
          status: "failed",
          failures: current.failures,
        });
        emitStaticFrameChange(key);
      }
    },
    [key],
  );

  const ownsDecoder =
    entry?.status === "loading" && entry.owner === ownerRef.current;

  useEffect(() => {
    if (!ownsDecoder) return;
    const timeout = window.setTimeout(() => {
      const current = staticFrameEntries.get(key);
      if (current?.status === "loading" && current.owner === ownerRef.current) {
        staticFrameEntries.set(key, {
          status: "failed",
          failures: current.failures + 1,
        });
        emitStaticFrameChange(key);
      }
    }, DECODER_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [key, ownsDecoder]);

  if (entry?.status === "ready" && entry.src) {
    return <img src={entry.src} alt={alt} className={className} />;
  }

  if (!ownsDecoder) return <>{fallback}</>;

  const failOwnedCapture = () => {
    const current = staticFrameEntries.get(key);
    if (current?.status !== "loading" || current.owner !== ownerRef.current) {
      return;
    }
    staticFrameEntries.set(key, {
      status: "failed",
      failures: current.failures + 1,
    });
    emitStaticFrameChange(key);
  };

  return (
    <span ref={hostRef} className="relative block size-full">
      {fallback}
      <span className="pointer-events-none absolute inset-0 block size-full opacity-0">
        <AvatarMedia
          media={media}
          alt={alt}
          loadingStrategy="eager"
          className={className}
          onReady={() => {
            const owner = ownerRef.current;
            const host = hostRef.current;
            if (!host) return;
            void captureAfterPaint(host)
              .then((src) => {
                const current = staticFrameEntries.get(key);
                if (current?.status !== "loading" || current.owner !== owner) {
                  return;
                }
                if (!src) {
                  failOwnedCapture();
                  return;
                }
                staticFrameEntries.set(key, {
                  status: "ready",
                  failures: current.failures,
                  src,
                });
                emitStaticFrameChange(key);
              })
              .catch(failOwnedCapture);
          }}
          onError={failOwnedCapture}
        />
      </span>
    </span>
  );
}
