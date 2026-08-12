import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChatLoadingSkeleton } from "@/features/chat/ui/ChatLoadingSkeleton";
import { cn } from "@/shared/lib/cn";
import { Skeleton } from "@/shared/ui/skeleton";
import type { AppNavigationLocation } from "../types/appNavigation";

type PlaceholderWidth = "narrow" | "default" | "full";

const pageWidthClassName: Record<PlaceholderWidth, string> = {
  narrow: "max-w-3xl",
  default: "max-w-5xl",
  full: "max-w-none",
};

const placeholderKeys = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
] as const;

const galleryGridClassName = cn(
  "grid gap-x-8 gap-y-10",
  "grid-cols-2 sm:grid-cols-3",
  "xl:grid-cols-[repeat(4,minmax(0,16rem))] xl:justify-evenly",
);

const sessionGridClassName =
  "grid grid-cols-1 gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-[repeat(4,minmax(0,235px))] 2xl:grid-cols-[repeat(5,minmax(0,235px))] xl:justify-evenly";

export function AppContentPlaceholder({
  location,
}: {
  location: AppNavigationLocation;
}) {
  const { t } = useTranslation("common");

  return (
    <div
      aria-label={t("labels.preparingContent")}
      aria-live="polite"
      className="pointer-events-none flex h-full min-h-0 flex-1 flex-col overflow-hidden"
      role="status"
    >
      {renderLocationPlaceholder(location)}
    </div>
  );
}

function renderLocationPlaceholder(location: AppNavigationLocation): ReactNode {
  switch (location.view) {
    case "chat":
      return location.sessionId ? (
        <ChatLoadingSkeleton />
      ) : (
        <HomePromptPlaceholder />
      );
    case "home":
      return <HomeCanvasPlaceholder />;
    case "settings":
      return <SettingsPlaceholder />;
    case "skills":
      return location.skillId ? (
        <DetailPlaceholder tone="library" />
      ) : (
        <SkillsPlaceholder />
      );
    case "agents":
      return location.personaId ? (
        <DetailPlaceholder tone="profile" />
      ) : (
        <AgentsPlaceholder />
      );
    case "projects":
      return <ProjectsPlaceholder />;
    case "session-history":
      return <SessionHistoryPlaceholder />;
    case "automations":
      return renderAutomationsPlaceholder(location.route);
    case "builderbot":
      return renderBuilderbotPlaceholder(location.route);
    case "search":
      return <SearchPlaceholder />;
    case "design-system":
      return <DesignSystemPlaceholder />;
  }

  const exhaustiveLocation: never = location;
  return exhaustiveLocation;
}

function renderAutomationsPlaceholder(
  route: Extract<AppNavigationLocation, { view: "automations" }>["route"],
): ReactNode {
  switch (route.surface) {
    case "builder":
      return <BuilderPlaceholder compact={Boolean(route.automationId)} />;
    case "history":
      return <ActivityFeedPlaceholder selected={Boolean(route.selectedRun)} />;
    case "detail":
      return route.tab === "history" ? (
        <ActivityFeedPlaceholder selected={Boolean(route.selectedRunKey)} />
      ) : (
        <DetailPlaceholder tone="workbench" />
      );
    case "overview":
      return <WorkbenchOverviewPlaceholder />;
  }

  const exhaustiveRoute: never = route;
  return exhaustiveRoute;
}

function renderBuilderbotPlaceholder(
  route: Extract<AppNavigationLocation, { view: "builderbot" }>["route"],
): ReactNode {
  switch (route.surface) {
    case "task":
    case "automation":
      return <DetailPlaceholder tone="workbench" />;
    case "overview":
      return (
        <WorkbenchOverviewPlaceholder
          density={route.tab === "automations" ? "cards" : "rows"}
        />
      );
  }

  const exhaustiveRoute: never = route;
  return exhaustiveRoute;
}

function PagePlaceholder({
  children,
  contentClassName,
  width = "default",
}: {
  children: ReactNode;
  contentClassName?: string;
  width?: PlaceholderWidth;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-hidden">
      <div
        className={cn(
          "mx-auto flex h-full w-full flex-col px-6 pb-app-page-bottom pt-8 page-transition",
          pageWidthClassName[width],
        )}
      >
        <div className={cn("flex w-full flex-col gap-8", contentClassName)}>
          {children}
        </div>
      </div>
    </div>
  );
}

function PageHeaderPlaceholder({
  actions = 2,
  wide = false,
}: {
  actions?: number;
  wide?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 space-y-3">
        <Skeleton className="h-5 w-48 rounded-sm" />
        <Skeleton
          className={cn("h-4 max-w-full rounded-sm", wide ? "w-96" : "w-72")}
        />
      </div>
      {actions > 0 ? (
        <div className="flex items-center gap-2">
          {placeholderKeys.slice(0, actions).map((key) => (
            <Skeleton key={key} className="h-8 w-24 rounded-md" />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SearchPillPlaceholder({ className }: { className?: string }) {
  return <Skeleton className={cn("h-10 rounded-full", className)} />;
}

function TabStripPlaceholder({ count = 2 }: { count?: number }) {
  return (
    <div className="flex items-center gap-5">
      {placeholderKeys.slice(0, count).map((key) => (
        <Skeleton key={key} className="h-6 w-24 rounded-sm" />
      ))}
    </div>
  );
}

function HomePromptPlaceholder() {
  return (
    <div className="h-full w-full overflow-hidden">
      <div className="page-transition relative flex min-h-full flex-col items-center justify-center px-6 pb-4">
        <div className="flex w-full max-w-[600px] flex-col">
          <div className="mb-2 flex items-end gap-2 pl-4">
            <Skeleton className="h-16 w-48 rounded-sm" />
            <Skeleton className="mb-2 h-5 w-10 rounded-sm" />
          </div>
          <Skeleton className="mb-6 ml-4 h-6 w-56 rounded-sm" />
          <div className="rounded-md border border-border/60 bg-background/80 p-4 shadow-sm">
            <Skeleton className="mb-5 h-5 w-3/4 rounded-sm" />
            <div className="flex flex-wrap gap-2">
              <Skeleton className="h-7 w-24 rounded-full" />
              <Skeleton className="h-7 w-28 rounded-full" />
              <Skeleton className="h-7 w-20 rounded-full" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function HomeCanvasPlaceholder() {
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-canvas-base">
      <Skeleton className="absolute left-[7%] top-[12%] h-44 w-72 rounded-md" />
      <Skeleton className="absolute left-[42%] top-[9%] h-32 w-60 rounded-md" />
      <Skeleton className="absolute right-[9%] top-[22%] hidden h-64 w-80 rounded-md lg:block" />
      <Skeleton className="absolute bottom-[16%] left-[18%] h-56 w-64 rounded-md" />
      <Skeleton className="absolute bottom-[12%] right-[22%] hidden h-40 w-72 rounded-md md:block" />
      <div className="absolute right-6 top-6 flex gap-2">
        <Skeleton className="size-8 rounded-md" />
        <Skeleton className="size-8 rounded-md" />
      </div>
    </div>
  );
}

function SkillsPlaceholder() {
  return (
    <PagePlaceholder width="full" contentClassName="gap-10">
      <div className={galleryGridClassName}>
        <div className="col-span-full sm:col-span-2">
          <SearchPillPlaceholder className="w-full" />
        </div>
      </div>
      <GalleryGridPlaceholder variant="text" />
    </PagePlaceholder>
  );
}

function AgentsPlaceholder() {
  return (
    <PagePlaceholder width="full" contentClassName="justify-center">
      <GalleryGridPlaceholder variant="avatar" />
    </PagePlaceholder>
  );
}

function GalleryGridPlaceholder({
  count = 8,
  variant,
}: {
  count?: number;
  variant: "avatar" | "text";
}) {
  return (
    <div className={galleryGridClassName}>
      {placeholderKeys.slice(0, count).map((key) => (
        <div key={key} className="flex w-full flex-col gap-4 p-2">
          {variant === "avatar" ? (
            <Skeleton className="aspect-square w-full rounded-sm" />
          ) : (
            <Skeleton className="h-5 w-24 rounded-sm" />
          )}
          <div className="space-y-3 px-1">
            {variant === "avatar" ? (
              <Skeleton className="h-px w-full rounded-none" />
            ) : null}
            <Skeleton className="h-5 w-28 rounded-full" />
            <Skeleton className="h-4 w-5/6 rounded-sm" />
            <Skeleton className="h-4 w-2/3 rounded-sm" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ProjectsPlaceholder() {
  return (
    <PagePlaceholder contentClassName="gap-5">
      <PageHeaderPlaceholder actions={1} />
      <SearchPillPlaceholder className="w-full max-w-md" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {placeholderKeys.slice(0, 6).map((key) => (
          <div
            key={key}
            className="rounded-md border border-border/60 bg-background/70 p-4"
          >
            <div className="mb-4 flex items-start gap-3">
              <Skeleton className="size-10 rounded-md" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-5 w-36 rounded-sm" />
                <Skeleton className="h-4 w-full rounded-sm" />
              </div>
            </div>
            <Skeleton className="h-4 w-2/3 rounded-sm" />
          </div>
        ))}
      </div>
    </PagePlaceholder>
  );
}

function SessionHistoryPlaceholder() {
  return (
    <PagePlaceholder width="full" contentClassName="gap-5">
      <div className={sessionGridClassName}>
        <div className="col-span-full sm:col-span-2">
          <SearchPillPlaceholder className="w-full" />
        </div>
      </div>
      <div className={sessionGridClassName}>
        {placeholderKeys.slice(0, 10).map((key) => (
          <div
            key={key}
            className="min-h-36 rounded-md border border-border/60 bg-background/70 p-4"
          >
            <div className="mb-4 flex items-center justify-between gap-3">
              <Skeleton className="h-5 w-32 rounded-sm" />
              <Skeleton className="size-6 rounded-md" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-4 w-full rounded-sm" />
              <Skeleton className="h-4 w-4/5 rounded-sm" />
            </div>
            <Skeleton className="mt-5 h-3 w-24 rounded-sm" />
          </div>
        ))}
      </div>
    </PagePlaceholder>
  );
}

function SettingsPlaceholder() {
  return (
    <div className="page-transition flex h-full min-h-0 flex-col px-[var(--spacing-app-panel-gutter-inline)] pt-[var(--spacing-app-panel-gutter-top)] pb-[var(--spacing-app-panel-gutter-bottom)]">
      <div className="min-h-0 flex-1 overflow-hidden rounded-md bg-card">
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-6 pt-8 pb-app-page-bottom">
          <div className="space-y-2">
            <Skeleton className="h-10 w-44 rounded-sm" />
            <Skeleton className="h-4 w-80 max-w-full rounded-sm" />
          </div>

          <div className="mt-6 space-y-11">
            {placeholderKeys.slice(0, 4).map((key, sectionIndex) => (
              <section key={key} className="space-y-3">
                {sectionIndex > 0 ? (
                  <Skeleton className="h-6 w-40 rounded-sm" />
                ) : null}
                <div className="divide-y divide-border">
                  {placeholderKeys
                    .slice(0, sectionIndex === 0 ? 4 : 3)
                    .map((rowKey) => (
                      <div
                        key={`${key}-${rowKey}`}
                        className="flex min-w-0 items-center gap-4 py-4 pr-4"
                      >
                        <div className="min-w-0 flex-1 space-y-2">
                          <Skeleton className="h-4 w-48 max-w-2/3 rounded-sm" />
                          <Skeleton className="h-3 w-80 max-w-full rounded-sm" />
                        </div>
                        <Skeleton className="h-7 w-16 shrink-0 rounded-full" />
                      </div>
                    ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function WorkbenchOverviewPlaceholder({
  density = "cards",
}: {
  density?: "cards" | "rows";
}) {
  return (
    <PagePlaceholder contentClassName="gap-6">
      <TabStripPlaceholder count={2} />
      {density === "rows" ? (
        <RowsPlaceholder />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {placeholderKeys.slice(0, 6).map((key) => (
            <div
              key={key}
              className="rounded-md border border-border/60 bg-background/70 p-5"
            >
              <Skeleton className="mb-4 h-5 w-48 rounded-sm" />
              <div className="space-y-2">
                <Skeleton className="h-4 w-full rounded-sm" />
                <Skeleton className="h-4 w-2/3 rounded-sm" />
              </div>
              <div className="mt-5 flex gap-2">
                <Skeleton className="h-6 w-20 rounded-full" />
                <Skeleton className="h-6 w-24 rounded-full" />
              </div>
            </div>
          ))}
        </div>
      )}
    </PagePlaceholder>
  );
}

function BuilderPlaceholder({ compact }: { compact: boolean }) {
  return (
    <PagePlaceholder contentClassName="gap-6">
      <PageHeaderPlaceholder actions={compact ? 1 : 0} wide />
      <div className="grid min-h-0 gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="rounded-md border border-border/60 bg-background/70 p-5">
          <div className="space-y-5">
            <Skeleton className="h-5 w-52 rounded-sm" />
            <Skeleton className="h-28 w-full rounded-md" />
            <Skeleton className="h-28 w-full rounded-md" />
            <Skeleton className="h-10 w-36 rounded-md" />
          </div>
        </div>
        <aside className="hidden space-y-4 lg:block">
          <Skeleton className="h-24 w-full rounded-md" />
          <Skeleton className="h-40 w-full rounded-md" />
        </aside>
      </div>
    </PagePlaceholder>
  );
}

function DetailPlaceholder({
  tone,
}: {
  tone: "library" | "profile" | "workbench";
}) {
  return (
    <PagePlaceholder contentClassName="gap-6">
      <PageHeaderPlaceholder actions={tone === "profile" ? 3 : 2} wide />
      <div className="grid min-h-0 gap-10 lg:grid-cols-[230px_minmax(0,1fr)]">
        <aside className="space-y-5">
          <Skeleton
            className={cn(
              "w-full rounded-md",
              tone === "profile" ? "aspect-square" : "h-32",
            )}
          />
          <Skeleton className="h-4 w-3/4 rounded-sm" />
          <Skeleton className="h-4 w-1/2 rounded-sm" />
        </aside>
        <div className="space-y-6">
          <section className="rounded-md border border-border/60 bg-background/70 p-5">
            <Skeleton className="mb-4 h-5 w-44 rounded-sm" />
            <div className="space-y-3">
              <Skeleton className="h-4 w-full rounded-sm" />
              <Skeleton className="h-4 w-11/12 rounded-sm" />
              <Skeleton className="h-4 w-3/5 rounded-sm" />
            </div>
          </section>
          <section className="rounded-md border border-border/60 bg-background/70 p-5">
            <Skeleton className="mb-4 h-5 w-36 rounded-sm" />
            <RowsPlaceholder count={tone === "workbench" ? 5 : 3} />
          </section>
        </div>
      </div>
    </PagePlaceholder>
  );
}

function ActivityFeedPlaceholder({ selected }: { selected: boolean }) {
  return (
    <PagePlaceholder contentClassName="gap-6">
      <PageHeaderPlaceholder actions={1} />
      <div
        className={cn(
          "grid gap-6",
          selected && "lg:grid-cols-[minmax(0,1fr)_22rem]",
        )}
      >
        <div className="space-y-4">
          {placeholderKeys.slice(0, 6).map((key) => (
            <div
              key={key}
              className="rounded-md border border-border/60 bg-background/70 p-4"
            >
              <div className="mb-3 flex items-center gap-3">
                <Skeleton className="size-8 rounded-full" />
                <div className="space-y-2">
                  <Skeleton className="h-4 w-44 rounded-sm" />
                  <Skeleton className="h-3 w-24 rounded-sm" />
                </div>
              </div>
              <Skeleton className="h-4 w-5/6 rounded-sm" />
            </div>
          ))}
        </div>
        {selected ? (
          <aside className="hidden rounded-md border border-border/60 bg-background/70 p-5 lg:block">
            <Skeleton className="mb-5 h-5 w-36 rounded-sm" />
            <div className="space-y-3">
              <Skeleton className="h-4 w-full rounded-sm" />
              <Skeleton className="h-4 w-full rounded-sm" />
              <Skeleton className="h-4 w-2/3 rounded-sm" />
            </div>
          </aside>
        ) : null}
      </div>
    </PagePlaceholder>
  );
}

function RowsPlaceholder({ count = 6 }: { count?: number }) {
  return (
    <div className="space-y-3">
      {placeholderKeys.slice(0, count).map((key) => (
        <div
          key={key}
          className="flex items-center gap-4 rounded-md border border-border/60 bg-background/70 p-4"
        >
          <Skeleton className="size-8 rounded-md" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-1/2 rounded-sm" />
            <Skeleton className="h-3 w-3/4 rounded-sm" />
          </div>
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>
      ))}
    </div>
  );
}

function SearchPlaceholder() {
  return (
    <section className="relative h-full w-full overflow-hidden">
      <div className="absolute left-1/2 top-[34%] w-[min(680px,calc(100%-48px))] -translate-x-1/2">
        <SearchPillPlaceholder className="h-12 w-full" />
      </div>
      <div
        className="absolute left-[37px] right-6 flex gap-9 overflow-hidden pb-4"
        style={{ top: "clamp(260px, 39vh, 374px)" }}
      >
        {placeholderKeys.slice(0, 4).map((key) => (
          <div
            key={key}
            className="w-72 shrink-0 rounded-md border border-border/60 bg-background/70 p-4"
          >
            <Skeleton className="mb-4 h-4 w-24 rounded-sm" />
            <RowsPlaceholder count={3} />
          </div>
        ))}
      </div>
    </section>
  );
}

function DesignSystemPlaceholder() {
  return (
    <PagePlaceholder contentClassName="gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <Skeleton className="h-8 w-32 rounded-md" />
        <Skeleton className="h-8 w-28 rounded-md" />
        <Skeleton className="h-8 w-36 rounded-md" />
      </div>
      <PageHeaderPlaceholder actions={0} wide />
      <div className="grid gap-4 md:grid-cols-2">
        {placeholderKeys.slice(0, 6).map((key) => (
          <div
            key={key}
            className="rounded-md border border-border/60 bg-background/70 p-5"
          >
            <Skeleton className="mb-4 h-5 w-40 rounded-sm" />
            <div className="space-y-3">
              <Skeleton className="h-10 w-full rounded-md" />
              <Skeleton className="h-10 w-4/5 rounded-md" />
            </div>
          </div>
        ))}
      </div>
    </PagePlaceholder>
  );
}
