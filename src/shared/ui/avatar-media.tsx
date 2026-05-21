import {
  memo,
  useEffect,
  useRef,
  useState,
  type ReactEventHandler,
} from "react";
import type { ResolvedAvatarMedia } from "@/shared/avatars/catalog";
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

function stopVideo(video: HTMLVideoElement) {
  if (!video.hasAttribute("src") && !video.currentSrc) {
    return;
  }

  video.pause();
  video.removeAttribute("src");
  video.load();
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

    if (video.getAttribute("src") !== media.src) {
      video.setAttribute("src", media.src);
    }

    void video.play().catch(() => {});

    return () => stopVideo(video);
  }, [media.mediaType, media.src, shouldLoadVideo]);

  if (media.mediaType === "video") {
    return (
      <video
        ref={videoRef}
        loop
        muted
        poster={poster}
        playsInline
        preload={loadingStrategy === "eager" ? "metadata" : "none"}
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
