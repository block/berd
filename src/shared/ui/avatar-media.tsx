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
  onError?: ReactEventHandler<HTMLImageElement | HTMLVideoElement>;
}

const OCCASIONAL_INITIAL_DELAY_MS = { min: 750, max: 1_250 };
const OCCASIONAL_REPEAT_DELAY_MS = { min: 8_000, max: 14_000 };

function randomDelay({ min, max }: { min: number; max: number }): number {
  return min + Math.random() * (max - min);
}

function getVideoPreload(
  animatedAvatarsEnabled: boolean,
  shouldLoadVideo: boolean,
  loadingStrategy: AvatarMediaProps["loadingStrategy"],
  playbackMode: AvatarMediaProps["playbackMode"],
) {
  if (!animatedAvatarsEnabled && shouldLoadVideo) {
    // No poster asset today, so load the video to paint frame 0.
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

export const AvatarMedia = memo(function AvatarMedia({
  media,
  alt = "",
  className,
  lazy = false,
  loadingStrategy = lazy ? "lazy-once" : "eager",
  playbackMode = "loop",
  poster,
  onError,
}: AvatarMediaProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { enabled: animatedAvatarsEnabled } = useAnimatedAvatarsPreference();
  const prefersReducedMotion = usePrefersReducedMotion();
  const shouldAnimateVideo = animatedAvatarsEnabled && !prefersReducedMotion;
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
  }, [loadingStrategy, media.mediaType, media.src]);

  useEffect(() => {
    if (media.mediaType !== "video") {
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
    shouldAnimateVideo,
    shouldLoadVideo,
  ]);

  if (media.mediaType === "video") {
    const preload = getVideoPreload(
      shouldAnimateVideo,
      shouldLoadVideo,
      loadingStrategy,
      playbackMode,
    );

    return (
      <video
        ref={videoRef}
        loop={shouldAnimateVideo && playbackMode === "loop"}
        muted
        poster={poster}
        playsInline
        preload={preload}
        src={shouldLoadVideo ? media.src : undefined}
        role={alt ? "img" : undefined}
        aria-label={alt || undefined}
        aria-hidden={alt ? undefined : true}
        className={cn("aspect-square size-full object-cover", className)}
        onError={onError}
      />
    );
  }

  return (
    <img
      src={media.src}
      alt={alt}
      className={cn("aspect-square size-full object-cover", className)}
      onError={onError}
    />
  );
});
