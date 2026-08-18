import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useAgentUpdatesAvailable } from "@/features/providers/hooks/useAgentUpdatesAvailable";
import { cn } from "@/shared/lib/cn";
import type { AppView } from "@/app/AppShell";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { PrimaryNavigationSurface } from "@/features/navigation/ui/PrimaryNavigationSurface";
import type { CommandOutcome } from "@/features/berdctl/navigation";
import { SessionListCapability } from "@/features/sessions/capabilities/SessionListCapability";
import {
  DEFAULT_SETTINGS_SECTION,
  getVisibleSettingsSections,
  type SectionId,
} from "@/features/settings/ui/settingsSections";
import { useProfileCapabilities } from "@/shared/profile/capabilities";
import { usePaneScrollIntoView } from "./usePaneScrollIntoView";
import { PaneLayoutFrame } from "@/app/layout/panes/paneChrome";

type ArchiveChatResult = CommandOutcome | undefined;

export interface NavigationPanesViewProps {
  collapsed: boolean;
  width: number;
  isResizing?: boolean;
  /** Drop shadow on the panel when hovering the sidebar (or actively resizing). */
  elevatedShadow?: boolean;
  onSettingsClick?: () => void;
  onSettingsBack?: () => void;
  onSettingsSectionChange?: (section: SectionId) => void;
  onNewChatInProject?: (projectId: string) => void;
  onNewChat?: () => void;
  onCreateProject?: () => void;
  onEditProject?: (projectId: string) => void;
  onArchiveProject?: (projectId: string) => void;
  onArchiveChat?: (
    sessionId: string,
  ) => ArchiveChatResult | Promise<ArchiveChatResult>;
  onRenameChat?: (sessionId: string, nextTitle: string) => void;
  onForkChat?: (sessionId: string) => void;
  onMarkChatRead?: (sessionId: string) => void;
  onMarkChatUnread?: (sessionId: string) => void;
  onMoveToProject?: (sessionId: string, projectId: string | null) => void;
  onReorderProject?: (fromId: string, toId: string) => void;
  onNavigate?: (view: AppView) => void;
  onOpenProject?: (projectId: string) => void;
  onSelectSession?: (sessionId: string) => void;
  onProjectCreatedRevisionHandled?: (revision: number) => void;
  projectCreatedRevision?: number;
  activeView?: AppView;
  activeSettingsSection?: SectionId;
  activeSessionId?: string | null;
  className?: string;
  projects: ProjectInfo[];
}

// Height of the nav's bottom fade mask. Shared by the mask style and the
// scroll-into-view math so a row never lands underneath the fade.
const BOTTOM_MASK_PX = 48;
const BOTTOM_MASK = `linear-gradient(to bottom, black calc(100% - ${BOTTOM_MASK_PX}px), transparent 100%)`;
const TOP_MASK = `linear-gradient(to bottom, transparent 0, black ${BOTTOM_MASK_PX}px)`;
const BOTH_EDGE_MASK = `linear-gradient(to bottom, transparent 0, black ${BOTTOM_MASK_PX}px, black calc(100% - ${BOTTOM_MASK_PX}px), transparent 100%)`;
const BOTTOM_MASK_STYLE: CSSProperties = {
  maskImage: BOTTOM_MASK,
  WebkitMaskImage: BOTTOM_MASK,
};
const TOP_MASK_STYLE: CSSProperties = {
  maskImage: TOP_MASK,
  WebkitMaskImage: TOP_MASK,
};
const BOTH_EDGE_MASK_STYLE: CSSProperties = {
  maskImage: BOTH_EDGE_MASK,
  WebkitMaskImage: BOTH_EDGE_MASK,
};
const SCROLL_BOTTOM_EPSILON_PX = 1;
const ACTIVE_SCROLL_TOP_OFFSET_PX = 40;
const MAIN_NAV_SCROLL_TARGETS: ReadonlySet<AppView> = new Set([
  "home",
  "agents",
  "skills",
  "automations",
  "builderbot",
  "session-history",
]);

function hasScrollableContentBelow(
  element: HTMLElement,
  bottomEpsilonPx = SCROLL_BOTTOM_EPSILON_PX,
) {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight >
    bottomEpsilonPx
  );
}

function useTopMaskState(ref: RefObject<HTMLElement | null>) {
  const [showTopMask, setShowTopMask] = useState(false);

  const updateTopMask = useCallback(() => {
    const nextShowTopMask = Boolean(ref.current && ref.current.scrollTop > 1);
    setShowTopMask((current) =>
      current === nextShowTopMask ? current : nextShowTopMask,
    );
  }, [ref]);

  useLayoutEffect(() => {
    const scrollContainer = ref.current;
    if (!scrollContainer) return;
    updateTopMask();
    scrollContainer.addEventListener("scroll", updateTopMask, {
      passive: true,
    });
    return () => scrollContainer.removeEventListener("scroll", updateTopMask);
  }, [ref, updateTopMask]);

  return showTopMask;
}

function useBottomMaskState(
  ref: RefObject<HTMLElement | null>,
  bottomEpsilonPx = SCROLL_BOTTOM_EPSILON_PX,
) {
  const [showBottomMask, setShowBottomMask] = useState(false);

  const updateBottomMask = useCallback(() => {
    const nextShowBottomMask = ref.current
      ? hasScrollableContentBelow(ref.current, bottomEpsilonPx)
      : false;
    setShowBottomMask((current) =>
      current === nextShowBottomMask ? current : nextShowBottomMask,
    );
  }, [bottomEpsilonPx, ref]);

  useLayoutEffect(() => {
    const scrollContainer = ref.current;
    if (!scrollContainer) return;

    let raf = 0;
    const scheduleUpdate = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(updateBottomMask);
    };

    updateBottomMask();
    scrollContainer.addEventListener("scroll", updateBottomMask, {
      passive: true,
    });
    window.addEventListener("resize", scheduleUpdate);

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(scheduleUpdate);
    resizeObserver?.observe(scrollContainer);

    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? undefined
        : new MutationObserver(scheduleUpdate);
    mutationObserver?.observe(scrollContainer, {
      attributes: true,
      childList: true,
      subtree: true,
    });

    return () => {
      cancelAnimationFrame(raf);
      scrollContainer.removeEventListener("scroll", updateBottomMask);
      window.removeEventListener("resize", scheduleUpdate);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [ref, updateBottomMask]);

  return { showBottomMask, updateBottomMask };
}

function getSidebarSelector(attribute: string, value: string | null) {
  return value ? `[${attribute}="${CSS.escape(value)}"]` : null;
}

function getRovingSidebarButtons(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
  ).filter((button) => {
    const hiddenParent = button.closest("[aria-hidden='true'], [inert]");
    return !button.hidden && !hiddenParent;
  });
}

export function NavigationPanesView({
  collapsed,
  width,
  isResizing = false,
  elevatedShadow = false,
  onSettingsClick,
  onSettingsBack,
  onSettingsSectionChange,
  onNewChatInProject,
  onNewChat,
  onCreateProject,
  onEditProject,
  onArchiveProject,
  onArchiveChat,
  onRenameChat,
  onForkChat,
  onMarkChatRead,
  onMarkChatUnread,
  onMoveToProject,
  onReorderProject,
  onNavigate,
  onOpenProject,
  onSelectSession,
  onProjectCreatedRevisionHandled,
  projectCreatedRevision,
  activeView,
  activeSettingsSection = DEFAULT_SETTINGS_SECTION,
  activeSessionId,
  className,
  projects,
}: NavigationPanesViewProps) {
  const agentUpdatesAvailable = useAgentUpdatesAvailable();
  const navRef = useRef<HTMLElement>(null);
  const secondaryNavRef = useRef<HTMLElement>(null);
  const skipActiveSessionScrollRef = useRef<string | null>(null);
  const { showBottomMask, updateBottomMask } = useBottomMaskState(
    navRef,
    BOTTOM_MASK_PX,
  );
  const showTopMask = useTopMaskState(navRef);
  const { showBottomMask: showSecondaryBottomMask } = useBottomMaskState(
    secondaryNavRef,
    SCROLL_BOTTOM_EPSILON_PX,
  );
  const capabilities = useProfileCapabilities();
  const visibleSettingsSections = getVisibleSettingsSections(capabilities);
  const isSecondarySurface = activeView === "settings";
  const labelVisible = !collapsed;
  const labelTransition = "";

  const handleSessionSelectForScroll = useCallback((sessionId: string) => {
    skipActiveSessionScrollRef.current = sessionId;
  }, []);
  const shouldSkipActiveSessionScroll =
    activeSessionId !== null &&
    skipActiveSessionScrollRef.current === activeSessionId;
  const activeSessionScrollSelector = useMemo(
    () =>
      activeView === "chat" &&
      activeSessionId &&
      !collapsed &&
      !shouldSkipActiveSessionScroll
        ? getSidebarSelector("data-session-id", activeSessionId)
        : null,
    [activeSessionId, activeView, collapsed, shouldSkipActiveSessionScroll],
  );
  const activeMainNavScrollSelector = useMemo(
    () =>
      activeView && MAIN_NAV_SCROLL_TARGETS.has(activeView) && !collapsed
        ? getSidebarSelector("data-sidebar-nav-id", activeView)
        : null,
    [activeView, collapsed],
  );

  useEffect(() => {
    if (
      !activeSessionId ||
      skipActiveSessionScrollRef.current !== activeSessionId
    ) {
      skipActiveSessionScrollRef.current = null;
    }
  }, [activeSessionId]);

  usePaneScrollIntoView({
    containerRef: navRef,
    targetSelector: isSecondarySurface ? null : activeSessionScrollSelector,
    topOffsetPx: ACTIVE_SCROLL_TOP_OFFSET_PX,
    bottomOffsetPx: BOTTOM_MASK_PX,
    onAfterScroll: updateBottomMask,
  });

  usePaneScrollIntoView({
    containerRef: navRef,
    targetSelector: isSecondarySurface ? null : activeMainNavScrollSelector,
    topOffsetPx: ACTIVE_SCROLL_TOP_OFFSET_PX,
    bottomOffsetPx: BOTTOM_MASK_PX,
    onAfterScroll: updateBottomMask,
  });

  const handleSidebarNavKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (
        event.key !== "ArrowDown" &&
        event.key !== "ArrowUp" &&
        event.key !== "ArrowRight" &&
        event.key !== "ArrowLeft"
      ) {
        return;
      }

      const target = event.target;
      if (!(target instanceof HTMLButtonElement)) {
        return;
      }

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const buttons = getRovingSidebarButtons(event.currentTarget);
        const currentIndex = buttons.indexOf(target);
        if (currentIndex === -1) {
          return;
        }

        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const nextButton =
          buttons[(currentIndex + direction + buttons.length) % buttons.length];
        nextButton?.focus();
        nextButton?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
        return;
      }

      const expanded = target.getAttribute("aria-expanded");
      if (expanded !== "true" && expanded !== "false") {
        return;
      }

      if (
        (event.key === "ArrowRight" && expanded === "false") ||
        (event.key === "ArrowLeft" && expanded === "true")
      ) {
        event.preventDefault();
        target.click();
      }
    },
    [],
  );

  return (
    <PaneLayoutFrame
      className={cn(
        !isResizing && "transition-[width] duration-300 ease-in-out",
        className,
      )}
      testId="sidebar-root"
      width={width}
    >
      <PrimaryNavigationSurface
        activeSettingsSection={activeSettingsSection}
        activeView={activeView}
        agentUpdatesAvailable={agentUpdatesAvailable}
        bottomMaskStyle={BOTTOM_MASK_STYLE}
        topMaskStyle={TOP_MASK_STYLE}
        bothEdgeMaskStyle={BOTH_EDGE_MASK_STYLE}
        elevatedShadow={elevatedShadow}
        isSecondarySurface={isSecondarySurface}
        labelTransition={labelTransition}
        mainNavRef={navRef}
        navCollapsed={collapsed}
        navLabelVisible={labelVisible}
        onKeyDown={handleSidebarNavKeyDown}
        onNavigate={onNavigate}
        onSettingsBack={onSettingsBack}
        onSettingsClick={onSettingsClick}
        onSettingsSectionChange={onSettingsSectionChange}
        renderInlineSessionList={
          !collapsed
            ? () => (
                <SessionListCapability
                  activeSessionId={activeSessionId}
                  collapsed={collapsed}
                  labelTransition={labelTransition}
                  labelVisible={labelVisible}
                  onArchiveChat={onArchiveChat}
                  onArchiveProject={onArchiveProject}
                  onCreateProject={onCreateProject}
                  onEditProject={onEditProject}
                  onForkChat={onForkChat}
                  onMarkChatRead={onMarkChatRead}
                  onMarkChatUnread={onMarkChatUnread}
                  onMoveToProject={onMoveToProject}
                  onNavigate={onNavigate}
                  onOpenProject={onOpenProject}
                  onNewChat={onNewChat}
                  onNewChatInProject={onNewChatInProject}
                  onRenameChat={onRenameChat}
                  onReorderProject={onReorderProject}
                  onSelectSession={onSelectSession}
                  onSessionSelectForScroll={handleSessionSelectForScroll}
                  onProjectCreatedRevisionHandled={
                    onProjectCreatedRevisionHandled
                  }
                  projectCreatedRevision={projectCreatedRevision}
                  projects={projects}
                  surface={{
                    renderDragHandle: () => null,
                    showTopDivider: true,
                    variant: "embedded",
                  }}
                />
              )
            : undefined
        }
        secondaryNavRef={secondaryNavRef}
        settingsSections={visibleSettingsSections}
        showBottomMask={showBottomMask}
        showTopMask={showTopMask}
        showAutomationsSurface={capabilities.automations}
        showBuilderbotSurface={capabilities.builderbot}
        showSecondaryBottomMask={showSecondaryBottomMask}
        width={width}
      />
    </PaneLayoutFrame>
  );
}
