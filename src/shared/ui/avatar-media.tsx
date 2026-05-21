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
  playback?: "hover" | "always";
  poster?: string;
  onError?: ReactEventHandler<HTMLImageElement | HTMLVideoElement>;
}

function getVideoPreload(shouldLoadVideo: boolean) {
  if (shouldLoadVideo) {
    // Keep loaded videos ready so hover playback starts without reloading.
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
  playback = "hover",
  poster,
  onError,
}: AvatarMediaProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { enabled: animatedAvatarsEnabled } = useAnimatedAvatarsPreference();
  const prefersReducedMotion = usePrefersReducedMotion();
  const [isHovered, setIsHovered] = useState(false);
  const isVideo = media.mediaType === "video";
  const canAnimateVideo = animatedAvatarsEnabled && !prefersReducedMotion;
  const shouldAnimateVideo =
    canAnimateVideo && (playback === "always" || isHovered);
  const [shouldLoadVideo, setShouldLoadVideo] = useState(
    loadingStrategy === "eager",
  );

  useEffect(() => {
    if (!isVideo || loadingStrategy === "eager") {
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
  }, [isVideo, loadingStrategy, media.src]);

  useEffect(() => {
    if (!isVideo) {
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

    if (video.getAttribute("src") !== media.src) {
      video.setAttribute("src", media.src);
    }

    return () => stopVideo(video);
  }, [isVideo, media.src, shouldLoadVideo]);

  useEffect(() => {
    if (!isVideo || !shouldLoadVideo) {
      return;
    }

    const video = videoRef.current;
    if (!video) {
      return;
    }

    if (shouldAnimateVideo) {
      void video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [isVideo, media.src, shouldAnimateVideo, shouldLoadVideo]);

  if (isVideo) {
    const preload = getVideoPreload(shouldLoadVideo);

    return (
      <video
        ref={videoRef}
        loop={canAnimateVideo}
        muted
        poster={poster}
        playsInline
        preload={preload}
        role={alt ? "img" : undefined}
        aria-label={alt || undefined}
        aria-hidden={alt ? undefined : true}
        className={cn("aspect-square size-full object-cover", className)}
        onError={onError}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
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
