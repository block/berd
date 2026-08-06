import { IconCircleCheck } from "@tabler/icons-react";
import { cn } from "@/shared/lib/cn";
import { AvatarMedia } from "@/shared/ui/avatar-media";
import { Spinner } from "@/shared/ui/spinner";
import {
  useAvatarImage,
  useAvatarMediaState,
} from "@/shared/hooks/useAvatarSrc";

interface GloopieGenerationHeroProps {
  title: string;
  description: string;
  sampleAvatarRef?: string | null;
  ready?: boolean;
  compact?: boolean;
  animated?: boolean;
  className?: string;
}

/**
 * Borderless, centered status composition shared by the creator and agent form.
 * It intentionally reads as content, not as a status card.
 */
export function GloopieGenerationHero({
  title,
  description,
  sampleAvatarRef = null,
  ready = false,
  compact = false,
  animated = false,
  className,
}: GloopieGenerationHeroProps) {
  const media = useAvatarMediaState(sampleAvatarRef);
  const image = useAvatarImage(sampleAvatarRef);

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-3" : "gap-5",
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <div
        className={cn(
          "flex items-center justify-center",
          compact ? "size-28" : "size-44",
          animated && "animate-pulse motion-reduce:animate-none",
        )}
        aria-hidden="true"
      >
        {ready ? (
          // Sized like the app's other status glyphs (e.g. the create tile's
          // wand), not scaled up to fill the media slot — an oversized check
          // read as shouting.
          <IconCircleCheck className="size-8" stroke={1.5} />
        ) : image ? (
          <img
            alt=""
            src={image}
            className="h-full w-full object-contain opacity-90 brightness-0 dark:invert"
            draggable={false}
          />
        ) : sampleAvatarRef && media.media ? (
          <AvatarMedia
            media={media.media}
            alt=""
            lazy
            loadingStrategy="visible-video"
            className="h-full w-full object-contain opacity-90 brightness-0 dark:invert"
          />
        ) : (
          <Spinner className="size-5 text-muted-foreground" />
        )}
      </div>
      <div className="space-y-1.5">
        <p className={cn("text-foreground", compact ? "text-sm" : "text-base")}>
          {title}
        </p>
        <p
          className={cn(
            "mx-auto whitespace-pre-line text-muted-foreground",
            compact ? "max-w-64 text-xs" : "max-w-sm text-sm",
          )}
        >
          {description}
        </p>
      </div>
    </div>
  );
}
