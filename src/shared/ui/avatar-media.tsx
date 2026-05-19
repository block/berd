import { useEffect, useRef, useState, type ReactEventHandler } from "react";
import type { ResolvedAvatarMedia } from "@/shared/avatars/catalog";
import { cn } from "@/shared/lib/cn";

interface AvatarMediaProps {
  media: ResolvedAvatarMedia;
  alt?: string;
  className?: string;
  lazy?: boolean;
  onError?: ReactEventHandler<HTMLImageElement | HTMLVideoElement>;
}

export function AvatarMedia({
  media,
  alt = "",
  className,
  lazy = false,
  onError,
}: AvatarMediaProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [shouldLoadVideo, setShouldLoadVideo] = useState(!lazy);

  useEffect(() => {
    if (media.mediaType !== "video" || !lazy) {
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
          observer.disconnect();
        }
      },
      { rootMargin: "160px" },
    );

    observer.observe(video);
    return () => observer.disconnect();
  }, [lazy, media.mediaType, media.src]);

  if (media.mediaType === "video") {
    return (
      <video
        ref={videoRef}
        src={shouldLoadVideo ? media.src : undefined}
        autoPlay
        loop
        muted
        playsInline
        preload={lazy ? "none" : "metadata"}
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
}
