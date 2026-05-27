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
  poster?: string;
  onError?: ReactEventHandler<HTMLImageElement | HTMLVideoElement>;
}

function getVideoPreload(
  animatedAvatarsEnabled: boolean,
  shouldLoadVideo: boolean,
  loadingStrategy: AvatarMediaProps["loadingStrategy"],
) {
  if (!animatedAvatarsEnabled && shouldLoadVideo) {
    // No poster asset today, so load the video to paint frame 0.
    return "auto";
  }

  if (loadingStrategy === "eager") {
    return "metadata";
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

    if (shouldAnimateVideo) {
      void video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [media.mediaType, media.src, shouldAnimateVideo, shouldLoadVideo]);

  if (media.mediaType === "video") {
    const preload = getVideoPreload(
      shouldAnimateVideo,
      shouldLoadVideo,
      loadingStrategy,
    );

    return (
      <video
        ref={videoRef}
        loop={shouldAnimateVideo}
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
