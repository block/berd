import type { ReactEventHandler, ReactNode } from "react";
import { useAvatarImage, useAvatarMedia } from "@/shared/hooks/useAvatarSrc";
import type { Avatar } from "@/shared/types/agents";
import { AvatarMedia } from "@/shared/ui/avatar-media";

interface AvatarVisualProps {
  avatar: Avatar | null | undefined;
  alt?: string;
  className?: string;
  fallback?: ReactNode;
  loadingStrategy?: "eager" | "lazy-once" | "visible-video";
  onError?: ReactEventHandler<HTMLImageElement | HTMLVideoElement>;
}

/**
 * Renders every supported avatar representation through one surface.
 *
 * Small surfaces prefer a static image when one exists. User-generated and
 * legacy custom avatars may only have cached image or video media, so they
 * fall back to AvatarMedia instead of disappearing when no artifacts-catalog
 * image is available.
 */
export function AvatarVisual({
  avatar,
  alt = "",
  className,
  fallback = null,
  loadingStrategy = "visible-video",
  onError,
}: AvatarVisualProps) {
  const image = useAvatarImage(avatar);
  const media = useAvatarMedia(avatar);

  const staticImage = image ?? media?.posterSrc;
  if (staticImage) {
    return (
      <img
        src={staticImage}
        alt={alt}
        className={className}
        data-avatar-visual="image"
        onError={onError}
      />
    );
  }

  if (media) {
    return (
      <AvatarMedia
        media={media}
        alt={alt}
        poster={media.posterSrc}
        loadingStrategy={loadingStrategy}
        className={className}
        onError={onError}
      />
    );
  }

  return <>{fallback}</>;
}
