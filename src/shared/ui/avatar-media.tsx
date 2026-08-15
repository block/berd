import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactEventHandler,
} from "react";
import type { ResolvedAvatarMedia } from "@/shared/avatars/catalog";
import { useAnimatedAvatarsPreference } from "@/shared/avatars/avatarPlaybackPreferences";
import { cn } from "@/shared/lib/cn";

interface AvatarMediaProps {
  media: ResolvedAvatarMedia;
  alt?: string;
  className?: string;
  lazy?: boolean;
  loadingStrategy?: "eager" | "lazy-once" | "visible-video";
  playbackMode?: "loop" | "occasional";
  poster?: string;
  /**
   * Hold video playback on a still frame (the first decoded frame) while
   * true. Lets hosts drive hover-to-play fields where only the pointed-at
   * avatar moves. Images are unaffected; `onReady` still fires.
   */
  paused?: boolean;
  onError?: ReactEventHandler<HTMLImageElement | HTMLVideoElement>;
  /**
   * Fires once the media has actually painted something: first decoded frame
   * for videos, load for images. Lets hosts hold entrance animations until
   * there are real pixels, instead of popping in an empty box.
   */
  onReady?: () => void;
  onLoadedData?: ReactEventHandler<HTMLVideoElement>;
  onPlaying?: ReactEventHandler<HTMLVideoElement>;
}

const OCCASIONAL_INITIAL_DELAY_MS = { min: 750, max: 1_250 };
const OCCASIONAL_REPEAT_DELAY_MS = { min: 8_000, max: 14_000 };

function randomDelay({ min, max }: { min: number; max: number }): number {
  return min + Math.random() * (max - min);
}

function getVideoPreload(
  animationAllowed: boolean,
  paused: boolean,
  shouldLoadVideo: boolean,
  loadingStrategy: AvatarMediaProps["loadingStrategy"],
  playbackMode: AvatarMediaProps["playbackMode"],
  hasPoster: boolean,
) {
  if (!animationAllowed && shouldLoadVideo) {
    return hasPoster ? "none" : "auto";
  }

  // Paused-but-mounted videos (hover-to-play hosts) never call play(), so
  // nothing else forces data to load. They must still reach HAVE_CURRENT_DATA
  // for `loadeddata` to fire `onReady` (hosts hold entrance animations on it)
  // and for the first frame to be decoded. With "none"/"metadata" the tile
  // stayed invisible until the first hover started playback.
  if (paused && shouldLoadVideo) {
    return "auto";
  }

  if (loadingStrategy === "eager") {
    return "metadata";
  }

  if (playbackMode === "occasional" && shouldLoadVideo) {
    return "auto";
  }

  return "none";
}

function stopVideo(video: HTMLVideoElement) {
  if (!video.hasAttribute("src") && !video.currentSrc) {
    return;
  }

  video.pause();
  video.removeAttribute("src");
  video.load();
}

function paintStackedAlphaFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  maskCanvas: HTMLCanvasElement,
) {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (sourceWidth === 0 || sourceHeight < 2) {
    return;
  }

  const frameHeight = Math.floor(sourceHeight / 2);
  // Assigning canvas dimensions clears its backing store. Only resize when the
  // decoded media dimensions actually change; clearing on every animation
  // frame creates a blank compositor window that is visible while dragging.
  if (canvas.width !== sourceWidth || canvas.height !== frameHeight) {
    canvas.width = sourceWidth;
    canvas.height = frameHeight;
  }

  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  if (maskCanvas.width !== sourceWidth || maskCanvas.height !== frameHeight) {
    maskCanvas.width = sourceWidth;
    maskCanvas.height = frameHeight;
  }
  const maskContext = maskCanvas.getContext("2d");
  if (!maskContext) {
    return;
  }

  context.clearRect(0, 0, sourceWidth, frameHeight);
  context.drawImage(
    video,
    0,
    0,
    sourceWidth,
    frameHeight,
    0,
    0,
    sourceWidth,
    frameHeight,
  );
  maskContext.drawImage(
    video,
    0,
    frameHeight,
    sourceWidth,
    frameHeight,
    0,
    0,
    sourceWidth,
    frameHeight,
  );

  const color = context.getImageData(0, 0, sourceWidth, frameHeight);
  const mask = maskContext.getImageData(0, 0, sourceWidth, frameHeight);
  for (let index = 0; index < color.data.length; index += 4) {
    color.data[index + 3] = mask.data[index];
  }
  context.putImageData(color, 0, 0);
}

function getReducedMotionMediaQuery() {
  if (typeof window.matchMedia !== "function") {
    return null;
  }

  return window.matchMedia("(prefers-reduced-motion: reduce)");
}

function usePrefersReducedMotion() {
  const subscribe = useCallback((onStoreChange: () => void) => {
    const mediaQuery = getReducedMotionMediaQuery();
    if (!mediaQuery) {
      return () => {};
    }

    mediaQuery.addEventListener("change", onStoreChange);
    return () => {
      mediaQuery.removeEventListener("change", onStoreChange);
    };
  }, []);

  return useSyncExternalStore(
    subscribe,
    () => getReducedMotionMediaQuery()?.matches ?? false,
    () => false,
  );
}

function StackedAlphaVideo({
  media,
  alt,
  className,
  loadingStrategy,
  poster,
  onError,
  onReady,
  shouldAnimateVideo,
}: {
  media: ResolvedAvatarMedia;
  alt: string;
  className?: string;
  loadingStrategy: AvatarMediaProps["loadingStrategy"];
  poster?: string;
  onError?: ReactEventHandler<HTMLVideoElement>;
  onReady?: () => void;
  shouldAnimateVideo: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const readyFiredRef = useRef(false);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const [shouldLoadVideo, setShouldLoadVideo] = useState(
    loadingStrategy === "eager",
  );

  useEffect(() => {
    if (loadingStrategy === "eager") {
      setShouldLoadVideo(true);
      return;
    }

    setShouldLoadVideo(false);
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setShouldLoadVideo(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setShouldLoadVideo(true);
          if (loadingStrategy === "lazy-once") {
            observer.disconnect();
          }
        } else if (loadingStrategy === "visible-video") {
          setShouldLoadVideo(false);
        }
      },
      { rootMargin: "160px" },
    );

    observer.observe(canvas);
    return () => observer.disconnect();
  }, [loadingStrategy, media.src]);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) {
      return;
    }
    if (!maskCanvasRef.current) {
      maskCanvasRef.current = document.createElement("canvas");
    }
    const maskCanvas = maskCanvasRef.current;

    if (!shouldLoadVideo) {
      stopVideo(video);
      return;
    }

    let animationFrame = 0;
    const draw = () => {
      paintStackedAlphaFrame(video, canvas, maskCanvas);
      // First frame with real dimensions = pixels on screen; announce once.
      if (!readyFiredRef.current && video.videoWidth > 0) {
        readyFiredRef.current = true;
        onReadyRef.current?.();
      }
      if (shouldAnimateVideo) {
        animationFrame = window.requestAnimationFrame(draw);
      }
    };

    const drawWhenReady = () => {
      window.cancelAnimationFrame(animationFrame);
      draw();
    };

    video.addEventListener("loadeddata", drawWhenReady);
    video.addEventListener("seeked", drawWhenReady);

    if (shouldAnimateVideo) {
      void video.play().catch(() => {});
      draw();
    } else {
      video.pause();
      try {
        if (video.currentTime !== 0) {
          video.currentTime = 0;
        } else {
          drawWhenReady();
        }
      } catch {
        drawWhenReady();
      }
    }

    return () => {
      window.cancelAnimationFrame(animationFrame);
      video.removeEventListener("loadeddata", drawWhenReady);
      video.removeEventListener("seeked", drawWhenReady);
    };
  }, [media.src, shouldAnimateVideo, shouldLoadVideo]);

  return (
    <>
      <canvas
        ref={canvasRef}
        role={alt ? "img" : undefined}
        aria-label={alt || undefined}
        aria-hidden={alt ? undefined : true}
        className={cn("aspect-square size-full object-cover", className)}
      />
      <video
        ref={videoRef}
        loop={shouldAnimateVideo}
        muted
        poster={poster}
        playsInline
        preload={shouldLoadVideo ? "auto" : "none"}
        src={shouldLoadVideo ? media.src : undefined}
        className="fixed size-px opacity-0"
        onError={onError}
      />
    </>
  );
}

export const AvatarMedia = memo(function AvatarMedia({
  media,
  alt = "",
  className,
  lazy = false,
  loadingStrategy = lazy ? "lazy-once" : "eager",
  playbackMode = "loop",
  poster,
  paused = false,
  onError,
  onReady,
  onLoadedData,
  onPlaying,
}: AvatarMediaProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { enabled: animatedAvatarsEnabled } = useAnimatedAvatarsPreference();
  const prefersReducedMotion = usePrefersReducedMotion();
  // "Allowed" is the durable setting (user preference, reduced motion);
  // `paused` is transient host-driven gating (hover-to-play fields). Only
  // the durable setting may swap the rendered element to a poster <img> —
  // a paused-but-allowed video stays mounted and merely pauses, so hover
  // toggles never remount media (which flashed blank while re-decoding).
  const animationAllowed = animatedAvatarsEnabled && !prefersReducedMotion;
  const shouldAnimateVideo = animationAllowed && !paused;
  const effectivePoster = poster ?? media.posterSrc;
  // The visibility effect must re-attach its observer only when the rendered
  // element can actually swap between a poster <img> and a <video> — which
  // requires a poster to exist. Posterless media keeps the same <video>
  // element across preference changes, so its observer (and src) must stay
  // put; re-running the effect detaches the source for a frame (a blink).
  const observerRebindKey = effectivePoster ? animationAllowed : true;
  const [failedVideoSrc, setFailedVideoSrc] = useState<string>();
  const videoFailed = failedVideoSrc === media.src;
  const [shouldLoadVideo, setShouldLoadVideo] = useState(
    loadingStrategy === "eager",
  );

  useEffect(() => {
    if (media.mediaType !== "video" || loadingStrategy === "eager") {
      setShouldLoadVideo(true);
      return;
    }

    setShouldLoadVideo(false);
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setShouldLoadVideo(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setShouldLoadVideo(true);
          if (loadingStrategy === "lazy-once") {
            observer.disconnect();
          }
        } else if (loadingStrategy === "visible-video") {
          setShouldLoadVideo(false);
        }
      },
      { rootMargin: "160px" },
    );

    observer.observe(video);
    return () => observer.disconnect();
    // Keyed on `observerRebindKey` (not `shouldAnimateVideo` or the raw
    // preference): flipping the durable preference swaps the rendered
    // element between a poster <img> and a <video> — but only when a poster
    // exists — so only then must the observer re-attach to the new node.
    // This effect also resets shouldLoadVideo(false) on every run, detaching
    // the video src until the new observer's first callback, so re-running
    // it when nothing swapped blanks the tile for a frame: keying on the
    // transient `paused` flag caused the hover blink, and keying on the
    // preference for posterless media (same element either way) reproduced
    // the same blink on preference changes.
  }, [observerRebindKey, loadingStrategy, media.mediaType, media.src]);

  useEffect(() => {
    if (media.mediaType !== "video" || videoFailed) {
      return;
    }

    const video = videoRef.current;
    if (!video) {
      return;
    }

    if (!shouldLoadVideo) {
      stopVideo(video);
      return;
    }

    if (!shouldAnimateVideo) {
      video.pause();
      try {
        video.currentTime = 0;
      } catch {
        // The source may not be seekable until metadata is available.
      }
      return;
    }

    if (playbackMode === "loop") {
      void video.play().catch(() => {});
      return;
    }

    let disposed = false;
    let playbackTimer: number | null = null;

    const schedulePlayback = (initial: boolean) => {
      if (playbackTimer !== null) {
        window.clearTimeout(playbackTimer);
      }
      playbackTimer = window.setTimeout(
        () => {
          playbackTimer = null;
          if (disposed) {
            return;
          }
          try {
            video.currentTime = 0;
          } catch {
            // The media may not be seekable yet; play from its current frame.
          }
          void video.play().catch(() => {
            if (!disposed) {
              schedulePlayback(false);
            }
          });
        },
        randomDelay(
          initial ? OCCASIONAL_INITIAL_DELAY_MS : OCCASIONAL_REPEAT_DELAY_MS,
        ),
      );
    };

    const handleEnded = () => schedulePlayback(false);
    video.pause();
    video.addEventListener("ended", handleEnded);
    schedulePlayback(true);

    return () => {
      disposed = true;
      if (playbackTimer !== null) {
        window.clearTimeout(playbackTimer);
      }
      video.removeEventListener("ended", handleEnded);
    };
  }, [
    media.mediaType,
    media.src,
    playbackMode,
    videoFailed,
    shouldAnimateVideo,
    shouldLoadVideo,
  ]);

  if (media.mediaType === "video" && media.alphaMode === "stacked") {
    return (
      <StackedAlphaVideo
        media={media}
        alt={alt}
        className={className}
        loadingStrategy={loadingStrategy}
        poster={poster}
        onError={onError}
        onReady={onReady}
        shouldAnimateVideo={shouldAnimateVideo}
      />
    );
  }

  if (
    media.mediaType === "video" &&
    effectivePoster &&
    (videoFailed || !animationAllowed)
  ) {
    return (
      <img
        src={effectivePoster}
        alt={alt}
        className={cn("aspect-square size-full object-cover", className)}
        onError={onError}
        onLoad={onReady}
      />
    );
  }

  if (media.mediaType === "video") {
    const preload = getVideoPreload(
      animationAllowed,
      paused,
      shouldLoadVideo,
      loadingStrategy,
      playbackMode,
      Boolean(effectivePoster),
    );

    return (
      <video
        ref={videoRef}
        loop={shouldAnimateVideo && playbackMode === "loop"}
        muted
        poster={effectivePoster}
        playsInline
        preload={preload}
        src={shouldLoadVideo ? media.src : undefined}
        role={alt ? "img" : undefined}
        aria-label={alt || undefined}
        aria-hidden={alt ? undefined : true}
        className={cn("aspect-square size-full object-cover", className)}
        onError={(event) => {
          if (effectivePoster) {
            setFailedVideoSrc(media.src);
            return;
          }
          onError?.(event);
        }}
        onLoadedData={(event) => {
          onReady?.();
          onLoadedData?.(event);
        }}
        onPlaying={onPlaying}
      />
    );
  }

  return (
    <img
      src={media.src}
      alt={alt}
      loading={lazy ? "lazy" : "eager"}
      decoding="async"
      className={cn("aspect-square size-full object-cover", className)}
      onError={onError}
      onLoad={onReady}
    />
  );
});
