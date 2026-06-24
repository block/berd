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
import { useTranslation } from "react-i18next";
import { useAgentUpdatesAvailable } from "@/features/providers/hooks/useAgentUpdatesAvailable";
import { cn } from "@/shared/lib/cn";
import type { AppView } from "@/app/AppShell";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { PrimaryNavigationSurface } from "@/features/navigation/ui/PrimaryNavigationSurface";
import { SessionListCapability } from "@/features/sessions/capabilities/SessionListCapability";
import { SIDEBAR_DETACHED_PANEL_GAP_PX } from "@/shared/ui/sidebar-tokens";
import {
  DEFAULT_SETTINGS_SECTION,
  getVisibleSettingsSections,
  type SectionId,
} from "@/features/settings/ui/settingsSections";
import { isDesignSystemExplorerEnabled } from "@/features/design-system/lib/designSystemEnabled";
import {
  DEFAULT_DESIGN_SYSTEM_SECTION,
  type DesignSystemSection,
} from "@/features/design-system/ui/designSystemSections";
import { useProfileCapabilities } from "@/shared/profile/capabilities";
import { usePaneScrollIntoView } from "./usePaneScrollIntoView";
import {
  SIDEBAR_PRIMARY_NAV_COMPACT_WIDTH_PX,
  SIDEBAR_PRIMARY_NAV_EXPANDED_WIDTH_PX,
  getStackedNavigationPaneWidth,
  isPrimaryNavCompactWidth,
  resolveIndependentNavigationPaneSizes,
} from "@/app/layout/panes/paneSizeRules";
import {
  PaneDragHandle,
  PaneDragPreview,
  PaneDropIndicator,
  PaneLayoutFrame,
  PaneResizeRail,
  usePaneDrag,
  usePaneResize,
} from "@/app/layout/panes/paneChrome";
import type {
  ChatListPaneDock,
  PaneDragReleaseIntent,
  NavigationPaneSizes,
  NavigationResizablePaneId,
} from "@/app/layout/panes/paneTypes";

export interface NavigationPanesViewProps {
  collapsed: boolean;
  width: number;
  isResizing?: boolean;
  /** Drop shadow on the panel when hovering the sidebar (or actively resizing). */
  elevatedShadow?: boolean;
  onSettingsClick?: () => void;
  onSettingsBack?: () => void;
  onSettingsSectionChange?: (section: SectionId) => void;
  onDesignSystemBack?: () => void;
  onDesignSystemSectionChange?: (section: DesignSystemSection) => void;
  designSystemInspectorVisible?: boolean;
  onDesignSystemInspectorVisibleChange?: (visible: boolean) => void;
  onNewChatInProject?: (projectId: string) => void;
  onNewChat?: () => void;
  onCreateProject?: () => void;
  onEditProject?: (projectId: string) => void;
  onArchiveProject?: (projectId: string) => void;
  onArchiveChat?: (sessionId: string) => void | Promise<void>;
  onRenameChat?: (sessionId: string, nextTitle: string) => void;
  onForkChat?: (sessionId: string) => void;
  onMarkChatRead?: (sessionId: string) => void;
  onMarkChatUnread?: (sessionId: string) => void;
  onMoveToProject?: (sessionId: string, projectId: string | null) => void;
  onReorderProject?: (fromId: string, toId: string) => void;
  onNavigate?: (view: AppView) => void;
  onSelectSession?: (sessionId: string) => void;
  activeView?: AppView;
  activeSettingsSection?: SectionId;
  activeDesignSystemSection?: DesignSystemSection;
  activeSessionId?: string | null;
  detachableSessionListEnabled?: boolean;
  paneSizes?: NavigationPaneSizes;
  onPaneResizeBegin?: () => void;
  onPaneResizeEnd?: () => void;
  onPaneResize?: (paneId: NavigationResizablePaneId, width: number) => void;
  sessionListDock?: ChatListPaneDock;
  onSessionListDragRelease?: (intent: PaneDragReleaseIntent) => void;
  getSessionListDragPreviewDock?: (
    intent: PaneDragReleaseIntent,
  ) => ChatListPaneDock | null;
  className?: string;
  projects: ProjectInfo[];
}

// Height of the nav's bottom fade mask. Shared by the mask style and the
// scroll-into-view math so a row never lands underneath the fade.
const BOTTOM_MASK_PX = 48;
const BOTTOM_MASK = `linear-gradient(to bottom, black calc(100% - ${BOTTOM_MASK_PX}px), transparent 100%)`;
const BOTTOM_MASK_STYLE: CSSProperties = {
  maskImage: BOTTOM_MASK,
  WebkitMaskImage: BOTTOM_MASK,
};
const SCROLL_BOTTOM_EPSILON_PX = 1;
const ACTIVE_SCROLL_TOP_OFFSET_PX = 40;
const FULL_HEIGHT_SIDEBAR_PANEL_STYLE =
  "calc(100vh - var(--spacing-app-top-bar) - var(--spacing-app-panel-gutter-top) - var(--spacing-app-panel-gutter-bottom))";
const DEFAULT_STACKED_PRIMARY_NAV_PANEL_HEIGHT_PX = 244;
const MAIN_NAV_SCROLL_TARGETS: ReadonlySet<AppView> = new Set([
  "home",
  "agents",
  "skills",
  "automations",
  "builderbot",
  "session-history",
]);

function hasScrollableContentBelow(element: HTMLElement) {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight >
    SCROLL_BOTTOM_EPSILON_PX
  );
}

function useBottomMaskState(ref: RefObject<HTMLElement | null>) {
  const [showBottomMask, setShowBottomMask] = useState(false);

  const updateBottomMask = useCallback(() => {
    const nextShowBottomMask = ref.current
      ? hasScrollableContentBelow(ref.current)
      : false;
    setShowBottomMask((current) =>
      current === nextShowBottomMask ? current : nextShowBottomMask,
    );
  }, [ref]);

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
  onDesignSystemBack,
  onDesignSystemSectionChange,
  designSystemInspectorVisible = false,
  onDesignSystemInspectorVisibleChange,
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
  onSelectSession,
  activeView,
  activeSettingsSection = DEFAULT_SETTINGS_SECTION,
  activeDesignSystemSection = DEFAULT_DESIGN_SYSTEM_SECTION,
  activeSessionId,
  detachableSessionListEnabled = false,
  paneSizes,
  onPaneResizeBegin,
  onPaneResizeEnd,
  onPaneResize,
  sessionListDock = "stacked",
  onSessionListDragRelease,
  getSessionListDragPreviewDock,
  className,
  projects,
}: NavigationPanesViewProps) {
  const { t } = useTranslation(["sidebar", "common", "settings"]);
  const agentUpdatesAvailable = useAgentUpdatesAvailable();
  const navRef = useRef<HTMLElement>(null);
  const primaryNavPanelRef = useRef<HTMLDivElement>(null);
  const sessionListNavRef = useRef<HTMLElement>(null);
  const skipActiveSessionScrollRef = useRef<string | null>(null);
  const secondaryNavRef = useRef<HTMLElement>(null);
  const { showBottomMask, updateBottomMask } = useBottomMaskState(navRef);
  const {
    showBottomMask: showSessionListBottomMask,
    updateBottomMask: updateSessionListBottomMask,
  } = useBottomMaskState(sessionListNavRef);
  const { showBottomMask: showSecondaryBottomMask } =
    useBottomMaskState(secondaryNavRef);
  const [stackedPrimaryNavPanelHeight, setStackedPrimaryNavPanelHeight] =
    useState(DEFAULT_STACKED_PRIMARY_NAV_PANEL_HEIGHT_PX);
  const handleSessionSelectForScroll = useCallback((sessionId: string) => {
    skipActiveSessionScrollRef.current = sessionId;
  }, []);

  const labelVisible = !collapsed;
  const labelTransition = "";
  const canDetachSessionList = detachableSessionListEnabled && !collapsed;
  const rawPrimaryNavPanelWidth = canDetachSessionList
    ? (paneSizes?.primaryNav ?? width)
    : width;
  const rawSessionListPanelWidth = canDetachSessionList
    ? (paneSizes?.chatList ?? width)
    : width;
  const effectiveSessionListDock: ChatListPaneDock = canDetachSessionList
    ? sessionListDock
    : "stacked";
  const stackedNavigationPaneWidth = getStackedNavigationPaneWidth({
    primaryNav: rawPrimaryNavPanelWidth,
    chatList: rawSessionListPanelWidth,
  });
  const independentNavigationPaneSizes = canDetachSessionList
    ? resolveIndependentNavigationPaneSizes({
        primaryNav: rawPrimaryNavPanelWidth,
        chatList: rawSessionListPanelWidth,
      })
    : {
        primaryNav: rawPrimaryNavPanelWidth,
        chatList: rawSessionListPanelWidth,
      };
  const dragSurfaceWidth =
    effectiveSessionListDock === "side"
      ? Math.max(
          independentNavigationPaneSizes.primaryNav,
          independentNavigationPaneSizes.chatList,
        )
      : stackedNavigationPaneWidth;
  const {
    dragState: sessionListDrag,
    handleDragStart: handleSessionListDragStart,
    isDragging: sessionListDragging,
  } = usePaneDrag({
    enabled: canDetachSessionList,
    fallbackHeight: 320,
    fallbackWidth: rawSessionListPanelWidth,
    onRelease: onSessionListDragRelease,
    paneId: "chatList",
    surfaceSelector: "[data-sidebar-session-list-panel]",
    surfaceWidth: dragSurfaceWidth,
  });
  const sessionListDragIntent: PaneDragReleaseIntent | null = sessionListDrag
    ? {
        paneId: "chatList",
        startClientX: sessionListDrag.startX,
        startClientY: sessionListDrag.startY,
        currentClientX: sessionListDrag.currentX,
        currentClientY: sessionListDrag.currentY,
        surfaceWidth: dragSurfaceWidth,
        hasSeparated: sessionListDrag.hasSeparated,
      }
    : null;
  const sessionListDropDock = sessionListDragIntent?.hasSeparated
    ? (getSessionListDragPreviewDock?.(sessionListDragIntent) ?? null)
    : null;
  const visualSessionListDock = sessionListDropDock ?? effectiveSessionListDock;
  const visualSessionListSideDocked = visualSessionListDock === "side";
  const primaryNavPanelWidth =
    canDetachSessionList && !visualSessionListSideDocked
      ? stackedNavigationPaneWidth
      : independentNavigationPaneSizes.primaryNav;
  const sessionListPanelWidth =
    canDetachSessionList && !visualSessionListSideDocked
      ? stackedNavigationPaneWidth
      : independentNavigationPaneSizes.chatList;
  const navPanelCompact =
    canDetachSessionList &&
    visualSessionListSideDocked &&
    isPrimaryNavCompactWidth(primaryNavPanelWidth);
  const navCollapsed = collapsed || navPanelCompact;
  const navLabelVisible = !navCollapsed;
  const stackedDetachedLayout =
    canDetachSessionList && !visualSessionListSideDocked;
  const sidebarContentWidth = visualSessionListSideDocked
    ? primaryNavPanelWidth +
      SIDEBAR_DETACHED_PANEL_GAP_PX +
      sessionListPanelWidth
    : Math.max(primaryNavPanelWidth, sessionListPanelWidth);
  const capabilities = useProfileCapabilities();
  const showAutomationsSurface = capabilities.automations;
  const showBuilderbotSurface = capabilities.builderbot;
  const visibleSettingsSections = getVisibleSettingsSections(capabilities);
  const isSettingsSurface = activeView === "settings";
  const isDesignSystemSurface = activeView === "design-system";
  const isSecondarySurface = isSettingsSurface || isDesignSystemSurface;
  const showDesignSystemSettingsItem = isDesignSystemExplorerEnabled();
  const shouldSkipActiveSessionScroll =
    activeSessionId !== null &&
    skipActiveSessionScrollRef.current === activeSessionId;

  useLayoutEffect(() => {
    if (!stackedDetachedLayout) return;

    const element = primaryNavPanelRef.current;
    if (!element) return;

    const updatePanelHeight = () => {
      const nextHeight = element.getBoundingClientRect().height;
      if (nextHeight > 0) {
        setStackedPrimaryNavPanelHeight(nextHeight);
      }
    };

    updatePanelHeight();

    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(updatePanelHeight)
        : null;
    resizeObserver?.observe(element);
    window.addEventListener("resize", updatePanelHeight);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updatePanelHeight);
    };
  }, [stackedDetachedLayout]);

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
    containerRef: canDetachSessionList ? sessionListNavRef : navRef,
    targetSelector:
      isSecondarySurface && !canDetachSessionList
        ? null
        : activeSessionScrollSelector,
    topOffsetPx: ACTIVE_SCROLL_TOP_OFFSET_PX,
    bottomOffsetPx: BOTTOM_MASK_PX,
    onAfterScroll: canDetachSessionList
      ? updateSessionListBottomMask
      : updateBottomMask,
  });

  usePaneScrollIntoView({
    containerRef: navRef,
    targetSelector: isSecondarySurface ? null : activeMainNavScrollSelector,
    topOffsetPx: ACTIVE_SCROLL_TOP_OFFSET_PX,
    bottomOffsetPx: BOTTOM_MASK_PX,
    onAfterScroll: updateBottomMask,
  });

  const getPaneResizeStartWidth = useCallback(
    (paneId: NavigationResizablePaneId) =>
      paneId === "navigationStack"
        ? sidebarContentWidth
        : paneId === "primaryNav"
          ? primaryNavPanelWidth
          : sessionListPanelWidth,
    [primaryNavPanelWidth, sidebarContentWidth, sessionListPanelWidth],
  );
  const handlePaneResizeStart = usePaneResize<NavigationResizablePaneId>({
    enabled: canDetachSessionList,
    getStartWidth: getPaneResizeStartWidth,
    onResize: onPaneResize,
    onResizeBegin: onPaneResizeBegin,
    onResizeEnd: onPaneResizeEnd,
  });
  const handlePrimaryNavWidthToggle = useCallback(() => {
    if (!canDetachSessionList || !visualSessionListSideDocked) return;

    onPaneResize?.(
      "primaryNav",
      navPanelCompact
        ? SIDEBAR_PRIMARY_NAV_EXPANDED_WIDTH_PX
        : SIDEBAR_PRIMARY_NAV_COMPACT_WIDTH_PX,
    );
  }, [
    canDetachSessionList,
    navPanelCompact,
    onPaneResize,
    visualSessionListSideDocked,
  ]);
  const handleSessionListDockToggle = useCallback(() => {
    if (!canDetachSessionList) return;

    const releaseDeltaPx = Math.max(97, dragSurfaceWidth + 1);
    onSessionListDragRelease?.({
      paneId: "chatList",
      startClientX: 0,
      startClientY: 0,
      currentClientX:
        effectiveSessionListDock === "side" ? -releaseDeltaPx : releaseDeltaPx,
      currentClientY: 0,
      surfaceWidth: dragSurfaceWidth,
      hasSeparated: true,
    });
  }, [
    canDetachSessionList,
    dragSurfaceWidth,
    effectiveSessionListDock,
    onSessionListDragRelease,
  ]);
  const sessionListDockToggleLabel =
    effectiveSessionListDock === "side"
      ? t("actions.dockSessionListBelowNavigation")
      : t("actions.dockSessionListBesideNavigation");
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

  const renderSessionListDragHandle = () =>
    canDetachSessionList ? (
      <PaneDragHandle
        aria-label={sessionListDockToggleLabel}
        testId="sidebar-session-list-drag-handle"
        onActivate={handleSessionListDockToggle}
        onMouseDown={handleSessionListDragStart}
      />
    ) : null;

  const renderPaneResizeRail = (paneId: NavigationResizablePaneId) =>
    canDetachSessionList ? (
      <PaneResizeRail
        surfaceId={paneId}
        testId={`sidebar-pane-resize-${paneId}`}
        onResizeStart={handlePaneResizeStart}
        title={
          paneId === "navigationStack"
            ? t("actions.resizeSidebarPanels")
            : paneId === "primaryNav"
              ? t("actions.resizeNavigationPanel")
              : t("actions.resizeSessionListPanel")
        }
      />
    ) : null;

  const renderDetachedSessionListSurface = ({
    preview = false,
  }: {
    preview?: boolean;
  } = {}) => (
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
      onNewChat={onNewChat}
      onNewChatInProject={onNewChatInProject}
      onRenameChat={onRenameChat}
      onReorderProject={onReorderProject}
      onSelectSession={onSelectSession}
      onSessionSelectForScroll={handleSessionSelectForScroll}
      projects={projects}
      surface={{
        ariaLabel: t("navigation.sessionList"),
        bottomMaskStyle: BOTTOM_MASK_STYLE,
        elevatedHoverShadow: canDetachSessionList,
        navRef: sessionListNavRef,
        onKeyDown: handleSidebarNavKeyDown,
        preview,
        renderDragHandle: renderSessionListDragHandle,
        renderResizeRail: () => renderPaneResizeRail("chatList"),
        showBottomMask: showSessionListBottomMask,
        showTopDivider: false,
        sideDocked: visualSessionListSideDocked,
        variant: "panel",
      }}
    />
  );

  const sessionListDragPreview =
    sessionListDragging && sessionListDrag ? (
      <PaneDragPreview dragState={sessionListDrag}>
        {renderDetachedSessionListSurface({ preview: true })}
      </PaneDragPreview>
    ) : null;

  const paneLayoutOverlays = (
    <>
      {canDetachSessionList &&
        !visualSessionListSideDocked &&
        renderPaneResizeRail("navigationStack")}
      {sessionListDragging && sessionListDropDock && (
        <PaneDropIndicator
          dock={sessionListDropDock}
          sideLeft={primaryNavPanelWidth + SIDEBAR_DETACHED_PANEL_GAP_PX / 2}
          stackedTop={
            stackedPrimaryNavPanelHeight + SIDEBAR_DETACHED_PANEL_GAP_PX / 2
          }
          stackedWidth={primaryNavPanelWidth}
        />
      )}
      {sessionListDragPreview}
    </>
  );

  return (
    <PaneLayoutFrame
      className={cn(
        !isResizing &&
          !canDetachSessionList &&
          "transition-[width] duration-300 ease-in-out",
        className,
      )}
      gapPx={SIDEBAR_DETACHED_PANEL_GAP_PX}
      height={
        canDetachSessionList ? FULL_HEIGHT_SIDEBAR_PANEL_STYLE : undefined
      }
      orientation={visualSessionListSideDocked ? "horizontal" : "vertical"}
      overlays={paneLayoutOverlays}
      testId="sidebar-root"
      width={sidebarContentWidth}
    >
      <PrimaryNavigationSurface
        ref={primaryNavPanelRef}
        activeDesignSystemSection={activeDesignSystemSection}
        activeSettingsSection={activeSettingsSection}
        activeView={activeView}
        agentUpdatesAvailable={agentUpdatesAvailable}
        bottomMaskStyle={BOTTOM_MASK_STYLE}
        detachable={canDetachSessionList}
        designSystemInspectorVisible={designSystemInspectorVisible}
        elevatedShadow={elevatedShadow}
        fullHeight={!canDetachSessionList || visualSessionListSideDocked}
        isSecondarySurface={isSecondarySurface}
        isSettingsSurface={isSettingsSurface}
        labelTransition={labelTransition}
        mainNavRef={navRef}
        navCollapsed={navCollapsed}
        navLabelVisible={navLabelVisible}
        navPanelCompact={navPanelCompact}
        onDesignSystemBack={onDesignSystemBack}
        onDesignSystemInspectorVisibleChange={
          onDesignSystemInspectorVisibleChange
        }
        onDesignSystemSectionChange={onDesignSystemSectionChange}
        onKeyDown={handleSidebarNavKeyDown}
        onNavigate={onNavigate}
        onPrimaryNavWidthToggle={handlePrimaryNavWidthToggle}
        onSettingsBack={onSettingsBack}
        onSettingsClick={onSettingsClick}
        onSettingsSectionChange={onSettingsSectionChange}
        renderInlineSessionList={
          !collapsed && !canDetachSessionList
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
                  onNewChat={onNewChat}
                  onNewChatInProject={onNewChatInProject}
                  onRenameChat={onRenameChat}
                  onReorderProject={onReorderProject}
                  onSelectSession={onSelectSession}
                  onSessionSelectForScroll={handleSessionSelectForScroll}
                  projects={projects}
                  surface={{
                    dragging: sessionListDragging,
                    renderDragHandle: renderSessionListDragHandle,
                    showTopDivider: true,
                    variant: "embedded",
                  }}
                />
              )
            : undefined
        }
        renderPrimaryNavResizeRail={
          visualSessionListSideDocked
            ? () => renderPaneResizeRail("primaryNav")
            : undefined
        }
        secondaryNavRef={secondaryNavRef}
        settingsSections={visibleSettingsSections}
        showBottomMask={showBottomMask}
        showAutomationsSurface={showAutomationsSurface}
        showBuilderbotSurface={showBuilderbotSurface}
        showDesignSystemSettingsItem={showDesignSystemSettingsItem}
        showPrimaryNavWidthToggle={
          canDetachSessionList && visualSessionListSideDocked
        }
        showSecondaryBottomMask={showSecondaryBottomMask}
        stackedDetachedLayout={stackedDetachedLayout}
        width={primaryNavPanelWidth}
      />
      {canDetachSessionList && (
        <div
          className={cn(
            "flex-shrink-0 transition-opacity duration-150",
            visualSessionListSideDocked ? "h-full" : "min-h-0 flex-1",
            sessionListDragging && "opacity-20",
          )}
          style={{ width: sessionListPanelWidth }}
        >
          {renderDetachedSessionListSurface()}
        </div>
      )}
    </PaneLayoutFrame>
  );
}
