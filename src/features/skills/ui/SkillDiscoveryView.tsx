import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconRefresh, IconTerminal2 } from "@tabler/icons-react";
import { Button } from "@/shared/ui/button";
import { Skeleton } from "@/shared/ui/skeleton";
import { skillsGridClass } from "./SkillsGrid";
import { RemoteSkillCard } from "./RemoteSkillCard";
import { remoteSkillMatchesQuery } from "../lib/remoteSkillFilter";
import type { RemoteSkill } from "../api/skillMarketplace";
import type { UseRemoteSkillsResult } from "../hooks/useRemoteSkills";

interface SkillDiscoveryViewProps {
  searchQuery: string;
  remote: UseRemoteSkillsResult;
  onSelectSkill: (skill: RemoteSkill) => void;
  onInstallSkill: (skill: RemoteSkill) => void;
}

/** How many cards to reveal per progressive-disclosure page. */
const PAGE_SIZE = 24;

/** Per-card fade-in stagger, matching the installed skills grid. */
const GALLERY_CARD_STAGGER_MS = 55;

function SkeletonTile() {
  return (
    <div aria-hidden="true" className="flex w-full flex-col gap-3 p-2">
      <Skeleton className="h-5 w-24 rounded-xs" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}

/**
 * Discovery surface: browse the full Block skill catalog and install skills
 * without leaving the app. Backed by the `sq agents skills` CLI.
 *
 * The catalog is hundreds of skills, so cards are revealed progressively — an
 * initial page, then more as a sentinel near the bottom scrolls into view.
 * Renders an actionable empty state when the CLI is unavailable.
 */
export function SkillDiscoveryView({
  searchQuery,
  remote,
  onSelectSkill,
  onInstallSkill,
}: SkillDiscoveryViewProps) {
  const { t } = useTranslation(["skills", "common"]);
  const { cliState, skills, loading, catalogState, installing, reload } =
    remote;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const visible = useMemo(
    () => skills.filter((skill) => remoteSkillMatchesQuery(skill, searchQuery)),
    [skills, searchQuery],
  );

  // Reset the reveal window when the query changes so a new search starts from
  // the top rather than mid-list. Adjusting state during render (React's
  // endorsed pattern) avoids an extra effect + render pass.
  const prevQueryRef = useRef(searchQuery);
  if (prevQueryRef.current !== searchQuery) {
    prevQueryRef.current = searchQuery;
    setVisibleCount(PAGE_SIZE);
  }

  const shown = visible.slice(0, visibleCount);
  const hasMore = visibleCount < visible.length;

  // Reveal the next page when the sentinel scrolls near the viewport.
  // Re-subscribing on `visibleCount` re-checks intersection after each reveal,
  // so a tall viewport that still shows the sentinel keeps loading instead of
  // stalling until the next manual scroll. `visibleCount` isn't read in the
  // body but is a required dependency: a still-intersecting sentinel won't
  // re-fire the observer, so we must re-observe after each reveal.
  // biome-ignore lint/correctness/useExhaustiveDependencies: visibleCount intentionally forces re-observation after each reveal
  useEffect(() => {
    if (!hasMore) {
      return;
    }
    const sentinel = sentinelRef.current;
    if (!sentinel) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((current) => current + PAGE_SIZE);
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, visibleCount]);

  if (cliState === "unavailable") {
    return (
      <div className="flex flex-col items-center gap-4 rounded-md border border-dashed border-border/60 px-6 py-16 text-center">
        <IconTerminal2
          className="size-8 text-muted-foreground"
          aria-hidden="true"
        />
        <div className="space-y-1">
          <p className="text-sm font-medium">{t("discover.cliMissingTitle")}</p>
          <p className="max-w-md text-sm text-muted-foreground">
            {t("discover.cliMissingDescription")}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void reload()}
          leftIcon={<IconRefresh />}
        >
          {t("discover.retry")}
        </Button>
      </div>
    );
  }

  if (catalogState === "error") {
    return (
      <div className="flex flex-col items-center gap-4 rounded-md border border-dashed border-border/60 px-6 py-16 text-center">
        <div className="space-y-1">
          <p className="text-sm font-medium">{t("discover.loadError")}</p>
          <p className="max-w-md text-sm text-muted-foreground">
            {t("discover.loadErrorDescription")}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void reload()}
          leftIcon={<IconRefresh />}
        >
          {t("discover.retry")}
        </Button>
      </div>
    );
  }

  if (loading || cliState === "checking" || cliState === "unknown") {
    return (
      <div
        role="status"
        aria-label={t("common:loading")}
        className={skillsGridClass}
      >
        <SkeletonTile />
        <SkeletonTile />
        <SkeletonTile />
        <SkeletonTile />
      </div>
    );
  }

  if (visible.length === 0) {
    return (
      <p className="px-1 py-10 text-center text-sm text-muted-foreground">
        {searchQuery.trim()
          ? t("discover.noResults", { query: searchQuery.trim() })
          : t("discover.empty")}
      </p>
    );
  }

  return (
    <>
      <div className={skillsGridClass}>
        {shown.map((skill, index) => (
          <div
            key={skill.name}
            className="gallery-card-enter h-full"
            style={{
              // Stagger within each page so freshly revealed cards animate
              // relative to their page rather than an ever-growing delay.
              animationDelay: `${(index % PAGE_SIZE) * GALLERY_CARD_STAGGER_MS}ms`,
            }}
          >
            <RemoteSkillCard
              skill={skill}
              installing={installing.has(skill.name)}
              onSelect={onSelectSkill}
              onInstall={onInstallSkill}
            />
          </div>
        ))}
      </div>
      {hasMore ? (
        <div ref={sentinelRef} aria-hidden="true" className={skillsGridClass}>
          <SkeletonTile />
          <SkeletonTile />
          <SkeletonTile />
          <SkeletonTile />
        </div>
      ) : null}
    </>
  );
}
