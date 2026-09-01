import { useTranslation } from "react-i18next";
import { IconCubePlus, IconEdit, IconPlus } from "@tabler/icons-react";
import type { AppView } from "@/app/AppShell";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { selectHasFetchedProjects } from "@/features/projects/stores/projectSelectors";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import type { FlatChatGroup } from "@/features/sidebar/lib/sidebarFlatChats";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { CollapseReveal } from "@/shared/ui/collapse-reveal";
import { DisclosureButton } from "@/shared/ui/disclosure-button";
import {
  SIDEBAR_GROUP_LABEL_TEXT_CLASS,
  SIDEBAR_ROW_HORIZONTAL_PADDING_CLASS,
  SIDEBAR_ROW_HEIGHT_CLASS,
  SIDEBAR_ROW_HOVER_CLASS,
} from "@/shared/ui/sidebar-tokens";
import { SidebarChatDragProvider } from "./SidebarChatDragContext";
import {
  SIDEBAR_SECTION_HEADER_ACTION_REVEAL_CLASS,
  SidebarSectionHeader,
  SidebarSectionHeaderAction,
} from "./SidebarSectionHeader";
import { SidebarFlatChatsSection } from "./SidebarFlatChatsSection";
import { SidebarDisplayOptionsMenu } from "./SidebarDisplayOptionsMenu";
import { SidebarProjectList } from "./SidebarProjectList";
import {
  SidebarProjectsInfoButton,
  useSidebarProjectsInfoMoment,
} from "./SidebarProjectsInfoButton";
import type { SidebarSessionItem } from "./SidebarProjectSection";
import { SidebarRecentsSection } from "./SidebarRecentsSection";
import { SidebarPinnedItemsSection } from "./SidebarPinnedItemsSection";

export type SidebarPinnedNavigationItem = {
  kind: "chat";
  session: SidebarSessionItem;
};

export interface SidebarProjectsSectionProps {
  projects: ProjectInfo[];
  pinnedNavigationItems?: SidebarPinnedNavigationItem[];
  onReorderPinnedNavigationItem?: (
    fromKey: string,
    toKey: string,
    placement: "before" | "after",
  ) => void;
  pinnedChatProjectIds?: ReadonlySet<string>;
  projectSessions: {
    byProject: Record<string, SidebarSessionItem[]>;
    standalone: SidebarSessionItem[];
    /** True when loaded standalone chats were truncated to the recents cap. */
    standaloneOverflow?: boolean;
  };
  hasVisibleChats: boolean;
  flatChatGroups: FlatChatGroup[];
  hasFlatChatOverflow: boolean;
  groupChatsByProject: boolean;
  onGroupChatsByProjectChange?: (grouped: boolean) => void;
  pinnedShowChatIcons: boolean;
  onPinnedShowChatIconsChange: (show: boolean) => void;
  pinnedShowTimestamps: boolean;
  onPinnedShowTimestampsChange: (show: boolean) => void;
  projectShowChatIcons: boolean;
  onProjectShowChatIconsChange: (show: boolean) => void;
  projectShowTimestamps: boolean;
  onProjectShowTimestampsChange: (show: boolean) => void;
  chatShowChatIcons: boolean;
  onChatShowChatIconsChange: (show: boolean) => void;
  chatShowTimestamps: boolean;
  onChatShowTimestampsChange: (show: boolean) => void;
  expandedProjects: Record<string, boolean>;
  toggleProject: (projectId: string) => void;
  collapsed: boolean;
  labelTransition: string;
  labelVisible: boolean;
  activeSessionId?: string | null;
  onNavigate?: (view: AppView) => void;
  onOpenProject?: (projectId: string) => void;
  onSelectSession?: (sessionId: string) => void;
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
  selectedSessionIds?: Set<string>;
  selectionEnabled?: boolean;
  selectionActionsDisabled?: boolean;
  onSelectionClear?: () => void;
  onSelectionChange?: (sessionId: string, selected: boolean) => void;
  onRangeSelect?: (sessionId: string) => void;
  onArchiveSelected?: () => void;
  onPinSelectedToHome?: () => void;
  onUnpinSelectedFromHome?: () => void;
  isSelectionPinnedToHome?: boolean;
  onOpenSelectedInWindows?: () => void;
  isPinningSelectedToHome?: boolean;
  onMarkSelectedRead?: () => void;
  onMarkSelectedUnread?: () => void;
  onReorderProject?: (
    fromId: string,
    toId: string,
    placement?: "before" | "after",
  ) => void;
  hasMoreSessions?: boolean;
  pinnedSectionOpen?: boolean;
  projectsSectionOpen: boolean;
  recentsSectionOpen: boolean;
  onTogglePinnedSection?: () => void;
  onToggleProjectsSection: () => void;
  onToggleRecentsSection: () => void;
  showTopDivider?: boolean;
}

/** Typography only — color comes from the ghost+flush toggle Button so the
 * label and chevron always match at rest and on hover. */
const SECTION_HEADER_TEXT_CLASS = SIDEBAR_GROUP_LABEL_TEXT_CLASS;

export function SidebarProjectsSection({
  projects,
  pinnedNavigationItems = [],
  onReorderPinnedNavigationItem,
  pinnedChatProjectIds,
  projectSessions,
  hasVisibleChats,
  flatChatGroups,
  hasFlatChatOverflow,
  groupChatsByProject,
  onGroupChatsByProjectChange,
  pinnedShowChatIcons,
  onPinnedShowChatIconsChange,
  pinnedShowTimestamps,
  onPinnedShowTimestampsChange,
  projectShowChatIcons,
  onProjectShowChatIconsChange,
  projectShowTimestamps,
  onProjectShowTimestampsChange,
  chatShowChatIcons,
  onChatShowChatIconsChange,
  chatShowTimestamps,
  onChatShowTimestampsChange,
  expandedProjects,
  toggleProject,
  collapsed,
  labelTransition,
  labelVisible,
  activeSessionId,
  onNavigate,
  onSelectSession,
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
  selectedSessionIds,
  selectionEnabled = false,
  selectionActionsDisabled = false,
  onSelectionClear,
  onSelectionChange,
  onRangeSelect,
  onArchiveSelected,
  onPinSelectedToHome,
  onUnpinSelectedFromHome,
  isSelectionPinnedToHome,
  onOpenSelectedInWindows,
  isPinningSelectedToHome = false,
  onMarkSelectedRead,
  onMarkSelectedUnread,
  onReorderProject,
  hasMoreSessions = false,
  pinnedSectionOpen = true,
  projectsSectionOpen,
  recentsSectionOpen,
  onTogglePinnedSection,
  onToggleProjectsSection,
  onToggleRecentsSection,
  showTopDivider: _showTopDivider = true,
}: SidebarProjectsSectionProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const showProjectsEmptyState = projects.length === 0;
  const hasFetchedProjects = useProjectStore(selectHasFetchedProjects);
  const projectsInfoMoment = useSidebarProjectsInfoMoment({
    hasProjects: !showProjectsEmptyState,
    projectsReady: hasFetchedProjects,
  });
  const showChatsEmptyState = projectSessions.standalone.length === 0;
  const showCombinedEmptyState = showProjectsEmptyState && !hasVisibleChats;
  const showProjects = collapsed || projectsSectionOpen;
  // Surface the Session History route whenever the grouped view can hide
  // chats: loaded standalone chats were truncated to the recents cap, or the
  // backend has more sessions than are loaded. Gating on loaded chat counts
  // would hide the link exactly when loading failed to reach the user's
  // chats, which is when the escape hatch is needed most. Brand-new users
  // have no chats and no backend pages, so they never see the link.
  const showGroupedHistoryLink =
    !collapsed &&
    ((projectSessions.standaloneOverflow ?? false) || hasMoreSessions);
  const emptyActionClasses = cn(
    SIDEBAR_ROW_HEIGHT_CLASS,
    SIDEBAR_ROW_HOVER_CLASS,
    "w-full justify-start gap-2 text-sm text-muted-foreground",
    SIDEBAR_ROW_HORIZONTAL_PADDING_CLASS,
  );
  const pinnedSection =
    pinnedNavigationItems.length > 0 ? (
      <SidebarPinnedItemsSection
        items={pinnedNavigationItems}
        isOpen={pinnedSectionOpen}
        onToggleOpen={onTogglePinnedSection ?? (() => {})}
        onReorder={onReorderPinnedNavigationItem}
        collapsed={collapsed}
        labelTransition={labelTransition}
        labelVisible={labelVisible}
        activeSessionId={activeSessionId}
        projectsById={new Map(projects.map((project) => [project.id, project]))}
        onSelectSession={onSelectSession}
        onEditProject={onEditProject}
        onArchiveChat={onArchiveChat}
        onRenameChat={onRenameChat}
        onForkChat={onForkChat}
        onMarkChatRead={onMarkChatRead}
        onMarkChatUnread={onMarkChatUnread}
        selectedSessionIds={selectedSessionIds}
        selectionEnabled={selectionEnabled}
        selectionActionsDisabled={selectionActionsDisabled}
        onSelectionClear={onSelectionClear}
        onSelectionChange={onSelectionChange}
        onRangeSelect={onRangeSelect}
        onArchiveSelected={onArchiveSelected}
        onPinSelectedToHome={onPinSelectedToHome}
        onUnpinSelectedFromHome={onUnpinSelectedFromHome}
        isSelectionPinnedToHome={isSelectionPinnedToHome}
        onOpenSelectedInWindows={onOpenSelectedInWindows}
        isPinningSelectedToHome={isPinningSelectedToHome}
        onMarkSelectedRead={onMarkSelectedRead}
        onMarkSelectedUnread={onMarkSelectedUnread}
        showChatIcons={pinnedShowChatIcons}
        onShowChatIconsChange={onPinnedShowChatIconsChange}
        showTimestamps={pinnedShowTimestamps}
        onShowTimestampsChange={onPinnedShowTimestampsChange}
      />
    ) : null;

  if (!groupChatsByProject) {
    return (
      <>
        {pinnedSection}
        <SidebarFlatChatsSection
          groups={flatChatGroups}
          onGroupChatsByProjectChange={onGroupChatsByProjectChange}
          collapsed={collapsed}
          labelTransition={labelTransition}
          labelVisible={labelVisible}
          activeSessionId={activeSessionId}
          onNewChat={onNewChat}
          onCreateProject={onCreateProject}
          onNavigate={onNavigate}
          onEditProject={onEditProject}
          onSelectSession={onSelectSession}
          onArchiveChat={onArchiveChat}
          onRenameChat={onRenameChat}
          onForkChat={onForkChat}
          onMarkChatRead={onMarkChatRead}
          onMarkChatUnread={onMarkChatUnread}
          selectedSessionIds={selectedSessionIds}
          selectionEnabled={selectionEnabled}
          selectionActionsDisabled={selectionActionsDisabled}
          onSelectionClear={onSelectionClear}
          onSelectionChange={onSelectionChange}
          onRangeSelect={onRangeSelect}
          onArchiveSelected={onArchiveSelected}
          onPinSelectedToHome={onPinSelectedToHome}
          onUnpinSelectedFromHome={onUnpinSelectedFromHome}
          isSelectionPinnedToHome={isSelectionPinnedToHome}
          onOpenSelectedInWindows={onOpenSelectedInWindows}
          isPinningSelectedToHome={isPinningSelectedToHome}
          onMarkSelectedRead={onMarkSelectedRead}
          onMarkSelectedUnread={onMarkSelectedUnread}
          showTimestamps={chatShowTimestamps}
          onShowTimestampsChange={onChatShowTimestampsChange}
          showViewAllInHistory={hasFlatChatOverflow}
          showTopDivider={_showTopDivider}
        />
      </>
    );
  }

  return (
    <SidebarChatDragProvider>
      <div
        className={cn(
          "relative z-10",
          labelTransition,
          labelVisible
            ? "opacity-100 max-h-[2000px]"
            : collapsed
              ? "opacity-100 max-h-[2000px]"
              : "opacity-0 max-h-0 overflow-hidden",
        )}
      >
        {pinnedSection}
        <SidebarSectionHeader
          label={t("sections.projects")}
          collapsed={collapsed}
          labelTransition={labelTransition}
          labelVisible={labelVisible}
          onToggleOpen={onToggleProjectsSection}
          isOpen={projectsSectionOpen}
          showChevron={!showProjectsEmptyState}
          labelClassName={SECTION_HEADER_TEXT_CLASS}
          labelAdornment={
            projectsInfoMoment.visible ? (
              <SidebarProjectsInfoButton moment={projectsInfoMoment} />
            ) : undefined
          }
          actions={
            !showProjectsEmptyState ? (
              <>
                <SidebarDisplayOptionsMenu
                  labelKey="actions.projectDisplayOptions"
                  showChatIcons={projectShowChatIcons}
                  onShowChatIconsChange={onProjectShowChatIconsChange}
                  showTimestamps={projectShowTimestamps}
                  onShowTimestampsChange={onProjectShowTimestampsChange}
                  groupChatsByProject
                  onGroupChatsByProjectChange={onGroupChatsByProjectChange}
                  className={SIDEBAR_SECTION_HEADER_ACTION_REVEAL_CLASS}
                />
                <SidebarSectionHeaderAction
                  icon={IconPlus}
                  label={t("actions.newProject")}
                  onClick={onCreateProject}
                />
              </>
            ) : null
          }
        />

        <CollapseReveal open={showProjects}>
          <SidebarProjectList
            projects={projects}
            projectSessionsByProject={projectSessions.byProject}
            pinnedChatProjectIds={pinnedChatProjectIds}
            expandedProjects={expandedProjects}
            toggleProject={toggleProject}
            collapsed={collapsed}
            activeSessionId={activeSessionId}
            onNavigate={onNavigate}
            onSelectSession={onSelectSession}
            onNewChatInProject={onNewChatInProject}
            onEditProject={onEditProject}
            onArchiveProject={onArchiveProject}
            onArchiveChat={onArchiveChat}
            onRenameChat={onRenameChat}
            onForkChat={onForkChat}
            onMarkChatRead={onMarkChatRead}
            onMarkChatUnread={onMarkChatUnread}
            onMoveToProject={onMoveToProject}
            selectedSessionIds={selectedSessionIds}
            selectionEnabled={selectionEnabled}
            selectionActionsDisabled={selectionActionsDisabled}
            onSelectionClear={onSelectionClear}
            onSelectionChange={onSelectionChange}
            onRangeSelect={onRangeSelect}
            onArchiveSelected={onArchiveSelected}
            onPinSelectedToHome={onPinSelectedToHome}
            onUnpinSelectedFromHome={onUnpinSelectedFromHome}
            isSelectionPinnedToHome={isSelectionPinnedToHome}
            onOpenSelectedInWindows={onOpenSelectedInWindows}
            isPinningSelectedToHome={isPinningSelectedToHome}
            onMarkSelectedRead={onMarkSelectedRead}
            onMarkSelectedUnread={onMarkSelectedUnread}
            showChatIcons={projectShowChatIcons}
            showTimestamps={projectShowTimestamps}
            onReorderProject={onReorderProject}
            hasMoreSessions={hasMoreSessions}
            dropTargetsEnabled={showProjects}
          />
        </CollapseReveal>

        {showProjectsEmptyState &&
          (collapsed ? (
            <div className="flex flex-col items-center gap-0">
              <Button
                type="button"
                variant="ghost"
                flush
                size="icon-xs"
                onClick={onCreateProject}
                aria-label={t("empty.createProject")}
                tooltip={t("empty.createProject")}
                className="rounded-lg"
              >
                <IconCubePlus className="size-4" />
              </Button>
            </div>
          ) : (
            <div className="space-y-0">
              <Button
                type="button"
                variant="ghost"
                flush
                size="xs"
                onClick={onCreateProject}
                className={emptyActionClasses}
                leftIcon={<IconCubePlus className="size-3.5" />}
              >
                {t("empty.createProject")}
              </Button>
            </div>
          ))}

        {showCombinedEmptyState && collapsed ? (
          <div className="flex flex-col items-center gap-0">
            <Button
              type="button"
              variant="ghost"
              flush
              size="icon-xs"
              onClick={onNewChat}
              aria-label={t("empty.startChat")}
              tooltip={t("empty.startChat")}
              className="rounded-lg"
            >
              <IconEdit className="size-4" />
            </Button>
          </div>
        ) : showCombinedEmptyState ? (
          <>
            <SidebarSectionHeader
              label={t("sections.recents")}
              collapsed={collapsed}
              labelTransition={labelTransition}
              labelVisible={labelVisible}
              labelClassName={SECTION_HEADER_TEXT_CLASS}
            />
            <div className="space-y-0">
              <Button
                type="button"
                variant="ghost"
                flush
                size="xs"
                onClick={onNewChat}
                className={emptyActionClasses}
                leftIcon={<IconEdit className="size-4" />}
              >
                {t("empty.startChat")}
              </Button>
            </div>
          </>
        ) : (
          <SidebarRecentsSection
            sessions={projectSessions.standalone}
            collapsed={collapsed}
            labelTransition={labelTransition}
            labelVisible={labelVisible}
            showEmptyState={showChatsEmptyState}
            activeSessionId={activeSessionId}
            onNewChat={onNewChat}
            onNavigate={onNavigate}
            onSelectSession={onSelectSession}
            onArchiveChat={onArchiveChat}
            onRenameChat={onRenameChat}
            onForkChat={onForkChat}
            onMarkChatRead={onMarkChatRead}
            onMarkChatUnread={onMarkChatUnread}
            onMoveToProject={onMoveToProject}
            selectedSessionIds={selectedSessionIds}
            selectionEnabled={selectionEnabled}
            selectionActionsDisabled={selectionActionsDisabled}
            onSelectionClear={onSelectionClear}
            onSelectionChange={onSelectionChange}
            onRangeSelect={onRangeSelect}
            onArchiveSelected={onArchiveSelected}
            onPinSelectedToHome={onPinSelectedToHome}
            onUnpinSelectedFromHome={onUnpinSelectedFromHome}
            isSelectionPinnedToHome={isSelectionPinnedToHome}
            onOpenSelectedInWindows={onOpenSelectedInWindows}
            isPinningSelectedToHome={isPinningSelectedToHome}
            onMarkSelectedRead={onMarkSelectedRead}
            onMarkSelectedUnread={onMarkSelectedUnread}
            showChatIcons={chatShowChatIcons}
            onShowChatIconsChange={onChatShowChatIconsChange}
            showTimestamps={chatShowTimestamps}
            onShowTimestampsChange={onChatShowTimestampsChange}
            isOpen={recentsSectionOpen}
            onToggleOpen={onToggleRecentsSection}
            sectionHeaderTextClass={SECTION_HEADER_TEXT_CLASS}
          />
        )}
        {showGroupedHistoryLink && onNavigate ? (
          <DisclosureButton
            type="button"
            surface="sidebarRow"
            onClick={() => onNavigate("session-history")}
            className={cn(
              "h-7 w-full justify-start rounded-sm px-3 py-1 text-sm",
              SIDEBAR_GROUP_LABEL_TEXT_CLASS,
            )}
          >
            {t("viewAllInHistory")}
          </DisclosureButton>
        ) : null}
      </div>
    </SidebarChatDragProvider>
  );
}
