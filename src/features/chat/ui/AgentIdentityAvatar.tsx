import { useState } from "react";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { cn } from "@/shared/lib/cn";
import type { Persona } from "@/shared/types/agents";
import { AvatarVisual } from "@/shared/ui/avatar-visual";
import { useAvatarImage, useAvatarMedia } from "@/shared/hooks/useAvatarSrc";
import { AvatarStaticMedia } from "@/shared/ui/avatar-static-media";

function normalizeAgentIdentity(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLocaleLowerCase();
}

function normalizedDisplayName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function findPersonaForAgentName(
  personas: readonly Persona[],
  agentName: string,
): Persona | undefined {
  const normalizedIdentity = normalizeAgentIdentity(agentName);
  if (!normalizedIdentity) return undefined;

  const exactIdentityMatch = personas.find(
    (persona) => normalizeAgentIdentity(persona.id) === normalizedIdentity,
  );
  if (exactIdentityMatch) return exactIdentityMatch;

  const baseIdentityMatches = personas.filter((persona) => {
    const normalizedId = normalizeAgentIdentity(persona.id);
    const baseName = normalizedId.split("/").at(-1)?.replace(/\.md$/, "");
    return baseName === normalizedIdentity;
  });
  if (baseIdentityMatches.length === 1) return baseIdentityMatches[0];

  const normalizedName = normalizedDisplayName(agentName);
  const displayMatches = personas.filter(
    (persona) => normalizedDisplayName(persona.displayName) === normalizedName,
  );
  return displayMatches.length === 1 ? displayMatches[0] : undefined;
}

function agentInitial(agentName: string): string {
  return agentName.match(/[\p{L}\p{N}]/u)?.[0]?.toLocaleUpperCase() ?? "?";
}

export function AgentIdentityAvatar({
  agentName,
  className,
}: {
  agentName: string;
  className?: string;
}) {
  const persona = useAgentStore((state) =>
    findPersonaForAgentName(state.personas, agentName),
  );
  const avatar = persona?.avatar;
  const staticImage = useAvatarImage(avatar);
  const media = useAvatarMedia(avatar);
  const resolvedSource = staticImage ?? media?.posterSrc ?? media?.src;
  const [failedSource, setFailedSource] = useState<string>();

  const sourceFailed = failedSource === resolvedSource;

  const fallback = (
    <span
      aria-hidden="true"
      data-agent-avatar-fallback=""
      className="flex size-full items-center justify-center rounded-full bg-muted text-[9px] font-medium text-muted-foreground"
    >
      {agentInitial(agentName)}
    </span>
  );

  const avatarContent = (() => {
    if (resolvedSource && sourceFailed) return fallback;
    if (media?.mediaType === "video" && !staticImage && !media.posterSrc) {
      return (
        <AvatarStaticMedia
          media={media}
          alt=""
          className="size-full rounded-full object-cover"
          fallback={fallback}
        />
      );
    }
    if (staticImage) {
      return (
        <img
          src={staticImage}
          alt=""
          className="size-full rounded-full object-cover"
          onError={() => setFailedSource(staticImage)}
        />
      );
    }
    return (
      <AvatarVisual
        avatar={avatar}
        alt=""
        className="size-full rounded-full object-cover"
        fallback={fallback}
        loadingStrategy="lazy-once"
        onError={() => {
          if (resolvedSource) setFailedSource(resolvedSource);
        }}
      />
    );
  })();

  return (
    <span
      aria-hidden="true"
      data-agent-identity-avatar={agentName}
      className={cn(
        "inline-flex size-5 shrink-0 overflow-hidden rounded-full",
        className,
      )}
    >
      {avatarContent}
    </span>
  );
}

const MAX_VISIBLE_AGENTS = 3;

export function ActiveAgentFacepile({
  agentNames,
  label,
}: {
  agentNames: readonly string[];
  label: string;
}) {
  if (agentNames.length === 0) return null;

  const visibleNames = agentNames.slice(0, MAX_VISIBLE_AGENTS);
  const overflowCount = agentNames.length - visibleNames.length;

  return (
    <span
      role="img"
      aria-label={label}
      data-active-agent-facepile=""
      className="ml-1 inline-flex shrink-0 items-center gap-0.5"
    >
      {visibleNames.map((agentName) => (
        <AgentIdentityAvatar
          key={agentName}
          agentName={agentName}
          className="ring-1 ring-card"
        />
      ))}
      {overflowCount > 0 ? (
        <span
          aria-hidden="true"
          className="relative inline-flex size-5 items-center justify-center rounded-full bg-muted text-[10px] font-medium tabular-nums text-muted-foreground ring-1 ring-card"
        >
          +{overflowCount}
        </span>
      ) : null}
    </span>
  );
}
