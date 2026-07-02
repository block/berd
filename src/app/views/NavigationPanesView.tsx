import {
  type ComponentProps,
  type CSSProperties,
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  Folder,
  FolderOpen,
  GitBranchPlus,
  History,
  ListFilter,
  Megaphone,
  MoreHorizontal,
  Pencil,
  PinIcon,
  Plus,
  Search,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import { useAgentUpdatesAvailable } from "@/features/providers/hooks/useAgentUpdatesAvailable";
import { usePinToHomeWidget } from "@/features/home/hooks/usePinToHomeWidget";
import { cn } from "@/shared/lib/cn";
import type { AppView } from "@/app/AppShell";
import type {
  ProjectChatGroupMetadata,
  ProjectChatGroupsMetadata,
  ProjectInfo,
} from "@/features/projects/api/projects";
import { PrimaryNavigationSurface } from "@/features/navigation/ui/PrimaryNavigationSurface";
import { DefaultProjectGlyphIcon } from "@/features/projects/ui/DefaultProjectGlyphIcon";
import {
  isImageProjectIcon,
  normalizeProjectIcon,
} from "@/features/projects/lib/projectIcons";
import { ProjectIcon } from "@/features/projects/ui/ProjectIcon";
import { useChatStore } from "@/features/chat/stores/chatStore";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { selectSessions } from "@/features/chat/stores/chatSessionSelectors";
import { getDisplaySessionTitle } from "@/features/chat/lib/sessionTitle";
import type { Message } from "@/shared/types/messages";
import type { CommandOutcome } from "@/features/berdctl/navigation";
import { SessionListCapability } from "@/features/sessions/capabilities/SessionListCapability";
import { SIDEBAR_DETACHED_PANEL_GAP_PX } from "@/shared/ui/sidebar-tokens";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import {
  DEFAULT_SETTINGS_SECTION,
  getVisibleSettingsSections,
  type SectionId,
} from "@/features/settings/ui/settingsSections";
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
  PaneSurface,
  usePaneDrag,
  usePaneResize,
} from "@/app/layout/panes/paneChrome";
import {
  SidebarNavAgentsIcon,
  SidebarNavAutomationsIcon,
  SidebarNavChatsIcon,
  SidebarNavHomeIcon,
  SidebarNavSettingsIcon,
  SidebarNavSkillsIcon,
} from "@/features/navigation/ui/sidebarNavIcons";
import type {
  ChatListPaneDock,
  PaneDragReleaseIntent,
  NavigationPaneSizes,
  NavigationResizablePaneId,
} from "@/app/layout/panes/paneTypes";

export type NavigationPrototypeMode =
  | "auto-collapse-push"
  | "manual-push"
  | "manual-float"
  | "hybrid-push-overlay";

export type NavigationSecondaryTarget =
  | { kind: "chats" }
  | { kind: "project"; projectId: string }
  | { kind: "settings" }
  | null;

export const NAV_PROTOTYPE_PRIMARY_EXPANDED_WIDTH_PX = 230;
export const NAV_PROTOTYPE_PRIMARY_COLLAPSED_WIDTH_PX = 48;
export const NAV_PROTOTYPE_SECONDARY_WIDTH_PX = 230;
export const NAV_PROTOTYPE_PANEL_GAP_PX = 0;
export const NAV_PROTOTYPE_PANEL_OVERLAP_PX = 1;
const NAV_PROTOTYPE_SECONDARY_EXIT_MS = 220;
const NAV_PROTOTYPE_ROW_HEIGHT_PX = 28;
const NAV_PROTOTYPE_ROW_GAP_PX = 1;
const NAV_PROTOTYPE_TRANSITION_CLASS =
  "transition-[width,left,transform] duration-250 ease-out";
const NAV_PROTOTYPE_PANEL_CONTENT_CLASS =
  "flex min-h-0 flex-1 flex-col overflow-hidden px-2 pb-2 pt-2.5";
const NAV_PROTOTYPE_SECTION_LABEL_CLASS =
  "text-[var(--sidebar-prototype-nav-muted-fg)]";
const NAV_PROTOTYPE_TEXT_MUTED_CLASS =
  "text-[var(--sidebar-prototype-nav-muted-fg)]";
const NAV_PROTOTYPE_TEXT_DEFAULT_CLASS =
  "text-[var(--sidebar-prototype-nav-default-fg)]";
const NAV_PROTOTYPE_TEXT_ACTIVE_CLASS =
  "text-[var(--sidebar-prototype-nav-active-fg)]";
const NAV_PROTOTYPE_ROW_ACTIVE_CLASS = `bg-[var(--sidebar-prototype-nav-row-active)] ${NAV_PROTOTYPE_TEXT_ACTIVE_CLASS}`;
const NAV_PROTOTYPE_ROW_HOVER_CLASS =
  "hover:bg-[var(--sidebar-prototype-nav-row-hover)] hover:text-[var(--sidebar-prototype-nav-active-fg)] focus-visible:bg-[var(--sidebar-prototype-nav-row-hover)] focus-visible:text-[var(--sidebar-prototype-nav-active-fg)]";
const NAV_PROTOTYPE_GROUP_ROW_HOVER_CLASS =
  "group-hover/prototype-project-group:bg-[var(--sidebar-prototype-nav-row-hover)] group-hover/prototype-project-group:text-[var(--sidebar-prototype-nav-active-fg)] focus-visible:bg-[var(--sidebar-prototype-nav-row-hover)] focus-visible:text-[var(--sidebar-prototype-nav-active-fg)]";
const NAV_PROTOTYPE_ICON_CLASS = "text-current";
const NAV_PROTOTYPE_ACTION_ICON_CLASS =
  "text-[var(--sidebar-prototype-nav-default-fg)] hover:text-[var(--sidebar-prototype-nav-active-fg)] focus-visible:text-[var(--sidebar-prototype-nav-active-fg)]";
const NAV_PROTOTYPE_SECTION_ACTION_ICON_CLASS =
  "rounded-sm text-[var(--sidebar-prototype-nav-muted-fg)] hover:bg-[var(--sidebar-prototype-nav-row-hover)] hover:text-[var(--sidebar-prototype-nav-active-fg)] focus-visible:bg-[var(--sidebar-prototype-nav-row-hover)] focus-visible:text-[var(--sidebar-prototype-nav-active-fg)]";
const NAV_PROTOTYPE_GROUP_ACTION_ICON_CLASS =
  "text-[var(--sidebar-prototype-nav-muted-fg)] hover:text-[var(--sidebar-prototype-nav-active-fg)] focus-visible:text-[var(--sidebar-prototype-nav-active-fg)]";
const NAV_PROTOTYPE_ICON_SLOT_CLASS =
  "flex size-4 shrink-0 items-center justify-center";
const NAV_PROTOTYPE_LUCIDE_ICON_CLASS = "size-3.5";
const NAV_PROTOTYPE_MENU_CONTENT_CLASS =
  "px-1 py-1 text-[14px] leading-[18px] [&_[data-slot=dropdown-menu-item]]:text-[14px] [&_[data-slot=dropdown-menu-item]]:leading-[18px]";
const NAV_PROTOTYPE_MENU_ITEM_CLASS =
  "gap-2 rounded-[6px] px-1.5 py-1 text-[14px] leading-[18px]";
const NAV_PROTOTYPE_ANNOUNCEMENT_DISMISSED_STORAGE_KEY =
  "goose:prototype-navigation-announcement-dismissed";
const NAV_PROTOTYPE_ROW_ACTION_RAIL_CLASS =
  "absolute right-1.5 z-10 flex items-center";
const PROTOTYPE_CHAT_LIST_BOTTOM_MASK =
  "linear-gradient(to bottom, black calc(100% - 40px), transparent 100%)";
const PROTOTYPE_CHAT_LIST_BOTTOM_MASK_STYLE: CSSProperties = {
  maskImage: PROTOTYPE_CHAT_LIST_BOTTOM_MASK,
  WebkitMaskImage: PROTOTYPE_CHAT_LIST_BOTTOM_MASK,
};
const NAV_PROTOTYPE_MENU_ITEM_STYLE: CSSProperties = {
  fontSize: "14px",
  lineHeight: "18px",
};
const PROTOTYPE_CHAT_VIEW_LABELS = {
  latest: "Latest",
  week: "Week",
  unread: "Unread",
  archived: "Archived",
} as const;

type PrototypeChatViewMode = keyof typeof PROTOTYPE_CHAT_VIEW_LABELS;

type PrototypeChatWeekGroup = {
  id: string;
  label: string;
  sessions: ChatSession[];
};

function getPrototypeRowsMaxHeight(rowCount: number) {
  return (
    rowCount * NAV_PROTOTYPE_ROW_HEIGHT_PX +
    Math.max(0, rowCount - 1) * NAV_PROTOTYPE_ROW_GAP_PX
  );
}

function navigationSecondaryTargetsEqual(
  a: NavigationSecondaryTarget,
  b: NavigationSecondaryTarget,
) {
  if (a?.kind !== b?.kind) return false;
  if (!a || !b) return a === b;
  if (a.kind === "chats" || b.kind === "chats") return true;
  if (a.kind === "settings" || b.kind === "settings") return true;
  return a.projectId === b.projectId;
}

export interface NavigationPanesViewProps {
  collapsed: boolean;
  width: number;
  isResizing?: boolean;
  /** Drop shadow on the panel when hovering the sidebar (or actively resizing). */
  elevatedShadow?: boolean;
  onSettingsClick?: () => void;
  onOpenSettingsSection?: (section: SectionId) => void;
  onSettingsBack?: () => void;
  onSettingsSectionChange?: (section: SectionId) => void;
  onNewChatInProject?: (
    projectId: string,
    options?: PrototypeProjectNewChatOptions,
  ) => ChatSession | Promise<ChatSession | undefined> | undefined;
  onNewChat?: PrototypeActionHandler;
  onCreateProject?: () => void;
  onEditProject?: (projectId: string) => void;
  onArchiveProject?: (projectId: string) => void;
  onUpdateProjectChatGroups?: (
    projectId: string,
    chatGroups: ProjectChatGroupsMetadata | null,
  ) => void | Promise<void>;
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
  onSelectSession?: (sessionId: string) => void;
  activeView?: AppView;
  activeSettingsSection?: SectionId;
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
  prototypeMode?: NavigationPrototypeMode | null;
  onPrototypeModeChange?: (mode: NavigationPrototypeMode) => void;
  prototypePrimaryCollapsed?: boolean;
  onPrototypePrimaryHoverChange?: (hovered: boolean) => void;
  prototypeSecondaryTarget?: NavigationSecondaryTarget;
  onPrototypeSecondaryTargetChange?: (
    target: NavigationSecondaryTarget,
  ) => void;
  onPrototypeSecondarySelect?: () => void;
  prototypeSecondaryPreview?: boolean;
  onPrototypeSecondaryPreviewChange?: (preview: boolean) => void;
  prototypePrimaryWidth?: number;
  prototypeSecondaryWidth?: number;
  prototypeSecondaryFloating?: boolean;
  prototypePrimaryOverlaysContent?: boolean;
  prototypeSecondaryPush?: boolean;
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

function eventTargetIsInsideElement(
  target: EventTarget | null,
  element: HTMLElement | null,
) {
  return target instanceof Node && element !== null && element.contains(target);
}

function compareSessionsByUpdatedAtDesc(a: ChatSession, b: ChatSession) {
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

function compareSessionsByArchivedAtDesc(a: ChatSession, b: ChatSession) {
  return (
    new Date(b.archivedAt ?? b.updatedAt).getTime() -
    new Date(a.archivedAt ?? a.updatedAt).getTime()
  );
}

function sessionMatchesQuery(session: ChatSession, query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return (
    session.title.toLowerCase().includes(normalizedQuery) ||
    (session.subtitle?.toLowerCase().includes(normalizedQuery) ?? false)
  );
}

function getPrototypeWeekStart(value: Date) {
  const weekStart = new Date(
    value.getFullYear(),
    value.getMonth(),
    value.getDate(),
  );
  const day = weekStart.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  weekStart.setDate(weekStart.getDate() + mondayOffset);
  weekStart.setHours(0, 0, 0, 0);
  return weekStart;
}

function formatPrototypeWeekLabel(weekStart: Date, now: Date) {
  const includeYear = weekStart.getFullYear() !== now.getFullYear();
  const formattedStart = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(includeYear ? { year: "numeric" as const } : {}),
  }).format(weekStart);

  return formattedStart;
}

function groupPrototypeChatsByWeek(
  sessions: ChatSession[],
  now = new Date(),
): PrototypeChatWeekGroup[] {
  const groups = new Map<string, PrototypeChatWeekGroup>();

  for (const session of sessions) {
    const updatedAt = new Date(session.updatedAt);
    const weekStart = getPrototypeWeekStart(
      Number.isFinite(updatedAt.getTime()) ? updatedAt : now,
    );
    const id = weekStart.toISOString();
    const existingGroup = groups.get(id);

    if (existingGroup) {
      existingGroup.sessions.push(session);
      continue;
    }

    groups.set(id, {
      id,
      label: formatPrototypeWeekLabel(weekStart, now),
      sessions: [session],
    });
  }

  return Array.from(groups.values()).sort(
    (a, b) => new Date(b.id).getTime() - new Date(a.id).getTime(),
  );
}

type PrototypeProjectChatItem = {
  id: string;
  placeholder?: boolean;
  session: ChatSession | null;
  subtitle?: string;
  title: string;
};

type PrototypeProjectGroup = {
  id: string;
  name: string;
  chats: PrototypeProjectChatItem[];
};

type PrototypeProjectChatPlacement = {
  chat: PrototypeProjectChatItem;
  groupId: string | null;
};

type PrototypeProjectNewChatOptions = {
  reuseExistingDraft?: boolean;
};

type ArchiveChatResult = CommandOutcome | undefined;

function archiveChatSucceeded(result: ArchiveChatResult) {
  return !result || result.ok;
}

type PrototypeActionHandler = () => void | Promise<void>;

function runPrototypeAction(
  action: PrototypeActionHandler | undefined,
  errorMessage: string,
) {
  if (!action) return;
  void Promise.resolve(action()).catch((error) => {
    console.error(errorMessage, error);
  });
}

function readPrototypeNavigationAnnouncementDismissed() {
  if (typeof window === "undefined") return false;
  try {
    return (
      window.localStorage.getItem(
        NAV_PROTOTYPE_ANNOUNCEMENT_DISMISSED_STORAGE_KEY,
      ) === "1"
    );
  } catch {
    return false;
  }
}

function writePrototypeNavigationAnnouncementDismissed() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      NAV_PROTOTYPE_ANNOUNCEMENT_DISMISSED_STORAGE_KEY,
      "1",
    );
  } catch {
    // localStorage can be unavailable in restricted contexts.
  }
}

function getPrototypeChatMessages({
  chat,
  groupName,
  projectName,
}: {
  chat: PrototypeProjectChatItem;
  groupName: string;
  projectName: string;
}): Message[] {
  const now = Date.now();
  const prefix = chat.id.replace(/[^a-zA-Z0-9_-]/g, "-");
  return [
    {
      id: `${prefix}-user`,
      role: "user",
      created: now - 45_000,
      content: [
        {
          type: "text",
          text: `Let's work through "${chat.title}" for ${projectName}.`,
        },
      ],
      metadata: { userVisible: true, agentVisible: true },
    },
    {
      id: `${prefix}-assistant`,
      role: "assistant",
      created: now - 30_000,
      content: [
        {
          type: "text",
          text: `Prototype note from ${groupName}: I would summarize the current state, identify the next decision, and keep the work tied to this project chat.`,
        },
      ],
      metadata: { userVisible: true, agentVisible: true },
    },
  ];
}

function groupPrototypeProjectSessions(
  project: ProjectInfo | null,
  sessions: ChatSession[],
): { groups: PrototypeProjectGroup[]; ungroupedSessions: ChatSession[] } {
  if (!project) return { groups: [], ungroupedSessions: sessions };
  const persistedGroups = project.chatGroups?.groups ?? [];
  if (persistedGroups.length === 0) {
    return { groups: [], ungroupedSessions: sessions };
  }

  const sessionsById = new Map(
    sessions.map((session) => [session.id, session]),
  );
  const sessionsByClientId = new Map(
    sessions
      .filter((session) => session.clientSessionId)
      .map((session) => [session.clientSessionId as string, session]),
  );
  const groupedSessionIds = new Set<string>();
  const groups = persistedGroups.map((group) => {
    const chats = group.chatIds
      .map(
        (chatId) => sessionsById.get(chatId) ?? sessionsByClientId.get(chatId),
      )
      .filter((session): session is ChatSession => Boolean(session))
      .map((session): PrototypeProjectChatItem => {
        groupedSessionIds.add(session.id);
        if (session.clientSessionId) {
          groupedSessionIds.add(session.clientSessionId);
        }

        return {
          id: session.id,
          session,
          title: session.title,
        };
      });

    return {
      id: group.id,
      name: group.name,
      chats,
    };
  });

  return {
    groups,
    ungroupedSessions: sessions.filter(
      (session) =>
        !groupedSessionIds.has(session.id) &&
        (!session.clientSessionId ||
          !groupedSessionIds.has(session.clientSessionId)),
    ),
  };
}

function PrototypeNavRow({
  active = false,
  collapsed,
  icon,
  label,
  onClick,
  onFocus,
  onMouseEnter,
  trailing,
}: {
  active?: boolean;
  collapsed: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  onFocus?: () => void;
  onMouseEnter?: () => void;
  trailing?: ReactNode;
}) {
  return (
    <div className="group/prototype-row relative flex items-center">
      <button
        type="button"
        onClick={onClick}
        onFocus={onFocus}
        onMouseEnter={onMouseEnter}
        title={collapsed ? label : undefined}
        aria-label={label}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex h-7 min-w-0 flex-1 items-center rounded-sm text-sm font-normal leading-normal outline-none transition-[background-color,color] duration-150",
          collapsed
            ? "justify-center gap-0 px-0"
            : cn("justify-start gap-2 pl-[10px]", trailing ? "pr-8" : "pr-3"),
          active
            ? NAV_PROTOTYPE_ROW_ACTIVE_CLASS
            : cn(
                NAV_PROTOTYPE_TEXT_DEFAULT_CLASS,
                NAV_PROTOTYPE_ROW_HOVER_CLASS,
              ),
        )}
      >
        <span
          className={cn(
            NAV_PROTOTYPE_ICON_SLOT_CLASS,
            NAV_PROTOTYPE_ICON_CLASS,
          )}
        >
          {icon}
        </span>
        <span
          className={cn(
            "min-w-0 overflow-hidden whitespace-nowrap transition-[max-width,opacity,transform] duration-150 ease-out",
            collapsed
              ? "max-w-0 -translate-x-1 opacity-0"
              : "max-w-[180px] translate-x-0 opacity-100",
          )}
        >
          <span className="block truncate">{label}</span>
        </span>
      </button>
      {!collapsed && trailing ? (
        <div
          className={cn(
            NAV_PROTOTYPE_ROW_ACTION_RAIL_CLASS,
            "gap-0.5 opacity-0 transition-opacity duration-150 group-hover/prototype-row:opacity-100 group-focus-within/prototype-row:opacity-100",
          )}
        >
          {trailing}
        </div>
      ) : null}
    </div>
  );
}

function PrototypeProjectNavRow({
  active,
  collapsed,
  onArchiveProject,
  onClick,
  onEditProject,
  onNewChat,
  project,
  prototypeNavMenuOpenRef,
}: {
  active: boolean;
  collapsed: boolean;
  onArchiveProject?: (projectId: string) => void;
  onClick: () => void;
  onEditProject?: (projectId: string) => void;
  onNewChat?: PrototypeActionHandler;
  project: ProjectInfo;
  prototypeNavMenuOpenRef: { current: boolean };
}) {
  const { t } = useTranslation(["sidebar", "common"]);
  const { isPinned, isPinning, pinToHome, unpinFromHome } = usePinToHomeWidget({
    kind: "project",
    id: project.id,
  });

  const pinLabel = isPinned
    ? t("common:actions.unpinFromHome")
    : isPinning
      ? t("common:actions.pinningToHome")
      : t("common:actions.pinToHome");

  return (
    <PrototypeNavRow
      active={active}
      collapsed={collapsed}
      icon={
        isImageProjectIcon(normalizeProjectIcon(project.icon)) ? (
          <ProjectIcon
            icon={project.icon}
            color={project.color}
            projectId={project.id}
            className="size-4 shrink-0"
            imageClassName="size-4 shrink-0 rounded-[3px]"
          />
        ) : (
          <DefaultProjectGlyphIcon
            projectId={project.id}
            className={cn("size-4", NAV_PROTOTYPE_ICON_CLASS)}
            style={{ color: "currentColor" }}
          />
        )
      }
      label={project.name}
      onClick={onClick}
      trailing={
        <>
          <PrototypeBareActionIcon
            label={`New chat in ${project.name}`}
            onClick={onNewChat ?? (() => {})}
          >
            <SquarePen className={NAV_PROTOTYPE_LUCIDE_ICON_CLASS} />
          </PrototypeBareActionIcon>
          <PrototypeNavMoreMenu
            alignOffset={-4}
            label={t("menu.optionsFor", {
              label: project.name,
            })}
            onOpenChange={(open) => {
              // The trigger click briefly leaves the primary nav. Mark any nav
              // menu open before Radix finishes portaling content so collapse
              // guards do not close the primary nav out from under the menu.
              prototypeNavMenuOpenRef.current = open;
            }}
            sideOffset={4}
          >
            <PrototypeNavMenuItem
              disabled={isPinning}
              onClick={() => (isPinned ? unpinFromHome() : void pinToHome())}
            >
              <PinIcon
                className="size-3.5"
                fill={isPinned ? "currentColor" : "none"}
              />
              {pinLabel}
            </PrototypeNavMenuItem>
            {onEditProject ? (
              <PrototypeNavMenuItem onClick={() => onEditProject(project.id)}>
                <Pencil className="size-3.5" />
                {t("common:actions.edit")}
              </PrototypeNavMenuItem>
            ) : null}
            {onArchiveProject ? (
              <PrototypeNavMenuItem
                onClick={() => onArchiveProject(project.id)}
              >
                <Trash2 className="size-3.5" />
                {t("common:actions.archive")}
              </PrototypeNavMenuItem>
            ) : null}
          </PrototypeNavMoreMenu>
        </>
      }
    />
  );
}

function PrototypeBareActionIcon({
  children,
  className,
  label,
  onClick,
}: {
  children: ReactNode;
  className?: string;
  label: string;
  onClick: PrototypeActionHandler;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        runPrototypeAction(onClick, `Failed to run ${label}`);
      }}
      onPointerDown={(event) => event.stopPropagation()}
      className={cn(
        "flex size-5 items-center justify-center border-0 bg-transparent p-0 transition-colors duration-150 focus-visible:outline-none",
        className ?? NAV_PROTOTYPE_ACTION_ICON_CLASS,
      )}
    >
      {children}
    </button>
  );
}

function PrototypeNavigationAnnouncement({
  onDismiss,
}: {
  onDismiss: () => void;
}) {
  return (
    <aside
      aria-label="Updated navigation announcement"
      className="mx-2 mb-3 rounded-[14px] bg-background/95 px-3 py-3 text-foreground shadow-[0_10px_30px_rgba(0,0,0,0.16)] backdrop-blur-md dark:bg-[var(--color-gray-800)] dark:shadow-[0_10px_30px_rgba(0,0,0,0.42)]"
    >
      <div className="flex items-start justify-between gap-2">
        <Megaphone className="mt-0.5 size-3.5 shrink-0 text-foreground" />
        <button
          type="button"
          aria-label="Dismiss updated navigation announcement"
          title="Dismiss updated navigation announcement"
          onClick={(event) => {
            event.stopPropagation();
            onDismiss();
          }}
          className="flex size-4 shrink-0 items-center justify-center border-0 bg-transparent p-0 text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <p className="mt-2 text-sm font-normal leading-[18px] text-foreground">
        Try the updated navigation
      </p>
      <p className="mt-1 text-sm leading-[18px] text-muted-foreground">
        Open Chats or a project to browse chats in the side panel. Group project
        chats to keep work organized.
      </p>
    </aside>
  );
}

function PrototypeNavMenuItem({
  className,
  style,
  ...props
}: ComponentProps<typeof DropdownMenuItem>) {
  return (
    <DropdownMenuItem
      className={cn(NAV_PROTOTYPE_MENU_ITEM_CLASS, className)}
      style={{
        ...NAV_PROTOTYPE_MENU_ITEM_STYLE,
        ...style,
      }}
      {...props}
    />
  );
}

function PrototypeChatFilterMenuItem({
  active,
  children,
  onSelect,
}: {
  active: boolean;
  children: ReactNode;
  onSelect: () => void;
}) {
  return (
    <PrototypeNavMenuItem
      className={cn(
        "text-popover-inverse-foreground focus:bg-white/10 focus:text-popover-inverse-foreground",
      )}
      onSelect={onSelect}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {active ? <Check className={NAV_PROTOTYPE_LUCIDE_ICON_CLASS} /> : null}
      </span>
      {children}
    </PrototypeNavMenuItem>
  );
}

function PrototypeNavMoreMenu({
  align = "start",
  alignOffset,
  children,
  label,
  onOpenChange,
  side = "right",
  sideOffset = 8,
  triggerClassName,
}: {
  align?: "center" | "end" | "start";
  alignOffset?: number;
  children: ReactNode;
  label: string;
  onOpenChange?: (open: boolean) => void;
  side?: "bottom" | "left" | "right" | "top";
  sideOffset?: number;
  triggerClassName?: string;
}) {
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-prototype-nav-menu-trigger="true"
          aria-label={label}
          title={label}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          className={cn(
            "flex size-5 items-center justify-center rounded-sm border-0 bg-transparent p-0 transition-[color,opacity] duration-75 focus-visible:outline-none",
            triggerClassName ?? NAV_PROTOTYPE_ACTION_ICON_CLASS,
          )}
        >
          <MoreHorizontal className={NAV_PROTOTYPE_LUCIDE_ICON_CLASS} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        variant="inverse"
        className={cn("w-40 rounded-[10px]", NAV_PROTOTYPE_MENU_CONTENT_CLASS)}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PrototypeSessionRow({
  active,
  project,
  session,
  onSelect,
}: {
  active: boolean;
  project?: ProjectInfo | null;
  session: ChatSession;
  onSelect?: (sessionId: string) => void;
}) {
  const { t } = useTranslation("common");
  const title = getDisplaySessionTitle(
    session.title,
    t("session.defaultTitle"),
  );

  return (
    <button
      type="button"
      data-session-id={session.id}
      onClick={() => onSelect?.(session.id)}
      className={cn(
        "flex h-7 w-full items-center gap-1.5 rounded-sm px-3 text-left text-sm font-normal leading-normal transition-colors duration-150",
        active
          ? NAV_PROTOTYPE_ROW_ACTIVE_CLASS
          : cn(NAV_PROTOTYPE_TEXT_DEFAULT_CLASS, NAV_PROTOTYPE_ROW_HOVER_CLASS),
      )}
    >
      {project ? (
        <ProjectIcon
          icon={project.icon}
          color={project.color}
          projectId={project.id}
          className="size-[18px]"
          imageClassName="size-[18px] rounded-[4px]"
        />
      ) : (
        <SidebarNavChatsIcon className="size-4 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">{title}</span>
    </button>
  );
}

function PrototypeProjectChatRow({
  active,
  chat,
  nested = false,
  onCreateGroup,
  onDelete,
  onMenuOpenChange,
  onPrototypeSelect,
  onSelect,
  showPlaceholderIcon = false,
}: {
  active: boolean;
  chat: PrototypeProjectChatItem;
  nested?: boolean;
  onCreateGroup?: (chat: PrototypeProjectChatItem) => void;
  onDelete?: (chat: PrototypeProjectChatItem) => void;
  onMenuOpenChange?: (open: boolean) => void;
  onPrototypeSelect?: (chat: PrototypeProjectChatItem) => void;
  onSelect?: (sessionId: string) => void;
  showPlaceholderIcon?: boolean;
}) {
  const { t } = useTranslation("common");
  const defaultSessionTitle = t("session.defaultTitle");
  const title = chat.session
    ? getDisplaySessionTitle(chat.session.title, defaultSessionTitle)
    : chat.title;
  const isUnsavedDefaultChat =
    title === defaultSessionTitle && (chat.session?.messageCount ?? 0) === 0;
  const showNewChatIcon = showPlaceholderIcon;
  const showActions = !chat.placeholder && !isUnsavedDefaultChat;

  const selectChat = () => {
    if (chat.session) {
      onSelect?.(chat.session.id);
    } else {
      onPrototypeSelect?.(chat);
    }
  };

  return (
    <div className="group/prototype-project-chat relative flex items-center">
      <button
        type="button"
        data-session-id={chat.session?.id ?? chat.id}
        onClick={selectChat}
        className={cn(
          "flex h-7 w-full items-center rounded-sm pr-8 text-left text-sm font-normal leading-normal transition-[background-color,color] duration-150",
          nested ? "pl-10" : "pl-3",
          showNewChatIcon && "gap-2",
          active
            ? NAV_PROTOTYPE_ROW_ACTIVE_CLASS
            : cn(
                NAV_PROTOTYPE_TEXT_DEFAULT_CLASS,
                NAV_PROTOTYPE_ROW_HOVER_CLASS,
              ),
        )}
      >
        {showNewChatIcon ? (
          <span
            data-testid="prototype-project-new-chat-icon"
            className={cn(
              NAV_PROTOTYPE_ICON_SLOT_CLASS,
              NAV_PROTOTYPE_TEXT_MUTED_CLASS,
            )}
          >
            <Plus className={NAV_PROTOTYPE_LUCIDE_ICON_CLASS} />
          </span>
        ) : null}
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            isUnsavedDefaultChat && NAV_PROTOTYPE_TEXT_MUTED_CLASS,
          )}
        >
          {title}
        </span>
      </button>
      {showActions ? (
        <div
          className={cn(
            NAV_PROTOTYPE_ROW_ACTION_RAIL_CLASS,
            "opacity-0 transition-opacity duration-150 group-hover/prototype-project-chat:opacity-100 group-focus-within/prototype-project-chat:opacity-100",
          )}
        >
          <PrototypeNavMoreMenu
            label={`Open actions for ${title}`}
            onOpenChange={onMenuOpenChange}
          >
            <PrototypeNavMenuItem onSelect={() => onCreateGroup?.(chat)}>
              <GitBranchPlus className={NAV_PROTOTYPE_LUCIDE_ICON_CLASS} />
              Create group
            </PrototypeNavMenuItem>
            <PrototypeNavMenuItem onSelect={() => onDelete?.(chat)}>
              <Trash2 className={NAV_PROTOTYPE_LUCIDE_ICON_CLASS} />
              Delete
            </PrototypeNavMenuItem>
          </PrototypeNavMoreMenu>
        </div>
      ) : null}
    </div>
  );
}

function PrototypeProjectGroupRow({
  group,
  expanded,
  onDeleteGroup,
  onMenuOpenChange,
  onNewChat,
  onRenameGroup,
  onToggle,
}: {
  group: PrototypeProjectGroup;
  expanded: boolean;
  onDeleteGroup?: () => void;
  onMenuOpenChange?: (open: boolean) => void;
  onNewChat?: PrototypeActionHandler;
  onRenameGroup?: () => void;
  onToggle: () => void;
}) {
  return (
    <div className="group/prototype-project-group relative flex items-center">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className={cn(
          "flex h-7 min-w-0 flex-1 items-center gap-2 rounded-sm pl-3 pr-14 text-left text-sm font-normal leading-normal transition-colors duration-150 focus-visible:outline-none",
          NAV_PROTOTYPE_TEXT_MUTED_CLASS,
          NAV_PROTOTYPE_GROUP_ROW_HOVER_CLASS,
        )}
      >
        <span
          className={cn(
            NAV_PROTOTYPE_ICON_SLOT_CLASS,
            NAV_PROTOTYPE_ICON_CLASS,
          )}
        >
          {expanded ? (
            <FolderOpen className={NAV_PROTOTYPE_LUCIDE_ICON_CLASS} />
          ) : (
            <Folder className={NAV_PROTOTYPE_LUCIDE_ICON_CLASS} />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate">{group.name}</span>
      </button>
      <div
        className={cn(
          NAV_PROTOTYPE_ROW_ACTION_RAIL_CLASS,
          "gap-2 opacity-0 transition-opacity duration-150 group-hover/prototype-project-group:opacity-100 group-focus-within/prototype-project-group:opacity-100",
        )}
      >
        <PrototypeBareActionIcon
          className={NAV_PROTOTYPE_GROUP_ACTION_ICON_CLASS}
          label="New chat in group"
          onClick={onNewChat ?? (() => {})}
        >
          <Plus className={NAV_PROTOTYPE_LUCIDE_ICON_CLASS} />
        </PrototypeBareActionIcon>
        <PrototypeNavMoreMenu
          label={`Open actions for ${group.name}`}
          onOpenChange={onMenuOpenChange}
          triggerClassName={NAV_PROTOTYPE_GROUP_ACTION_ICON_CLASS}
        >
          <PrototypeNavMenuItem onSelect={() => onRenameGroup?.()}>
            <Pencil className={NAV_PROTOTYPE_LUCIDE_ICON_CLASS} />
            Rename group
          </PrototypeNavMenuItem>
          <PrototypeNavMenuItem onSelect={() => onDeleteGroup?.()}>
            <Trash2 className={NAV_PROTOTYPE_LUCIDE_ICON_CLASS} />
            Delete group
          </PrototypeNavMenuItem>
        </PrototypeNavMoreMenu>
      </div>
    </div>
  );
}

function PrototypeSecondaryPanel({
  activeSessionId,
  activeSettingsSection,
  onCreateProject,
  onArchiveChat,
  onCommitPreview,
  onNavigationMenuOpenChange,
  onNavigate,
  onNewChatInProject,
  onOpenSettingsSection,
  onSecondarySelect,
  onSelectSession,
  onUpdateProjectChatGroups,
  projects,
  search,
  secondaryTarget,
  sessions,
  settingsSections,
  setSearch,
  width,
}: {
  activeSessionId?: string | null;
  activeSettingsSection: SectionId;
  onCreateProject?: () => void;
  onArchiveChat?: (
    sessionId: string,
  ) => ArchiveChatResult | Promise<ArchiveChatResult>;
  onCommitPreview?: () => void;
  onNavigationMenuOpenChange?: (open: boolean) => void;
  onNavigate?: (view: AppView) => void;
  onNewChatInProject?: (
    projectId: string,
    options?: PrototypeProjectNewChatOptions,
  ) => ChatSession | Promise<ChatSession | undefined> | undefined;
  onOpenSettingsSection?: (section: SectionId) => void;
  onSecondarySelect?: () => void;
  onSelectSession?: (sessionId: string) => void;
  onUpdateProjectChatGroups?: (
    projectId: string,
    chatGroups: ProjectChatGroupsMetadata | null,
  ) => void | Promise<void>;
  projects: ProjectInfo[];
  search: string;
  secondaryTarget: NavigationSecondaryTarget;
  sessions: ChatSession[];
  settingsSections: ReturnType<typeof getVisibleSettingsSections>;
  setSearch: (value: string) => void;
  width: number;
}) {
  const { t } = useTranslation(["sidebar", "common", "settings"]);
  const defaultSessionTitle = t("common:session.defaultTitle");
  const [expandedProjectGroupIds, setExpandedProjectGroupIds] = useState<
    Record<string, boolean>
  >({});
  const [selectedPrototypeChatId, setSelectedPrototypeChatId] = useState<
    string | null
  >(null);
  const [customProjectGroups, setCustomProjectGroups] = useState<
    Record<string, PrototypeProjectGroup[]>
  >({});
  const [renamedProjectGroupNames, setRenamedProjectGroupNames] = useState<
    Record<string, Record<string, string>>
  >({});
  const [deletedProjectGroupIds, setDeletedProjectGroupIds] = useState<
    Record<string, boolean>
  >({});
  const [projectChatPlacements, setProjectChatPlacements] = useState<
    Record<string, Record<string, PrototypeProjectChatPlacement>>
  >({});
  const [deletedProjectChatIds, setDeletedProjectChatIds] = useState<
    Record<string, boolean>
  >({});
  const [groupDialogChat, setGroupDialogChat] = useState<{
    projectId: string;
    chat: PrototypeProjectChatItem;
  } | null>(null);
  const [renameGroupDialog, setRenameGroupDialog] = useState<{
    projectId: string;
    groupId: string;
  } | null>(null);
  const [groupNameDraft, setGroupNameDraft] = useState("");
  const [chatViewMode, setChatViewMode] =
    useState<PrototypeChatViewMode>("latest");
  const sessionStateById = useChatStore((state) => state.sessionStateById);
  const visibleSessions = sessions
    .filter((session) => !session.archivedAt)
    .sort(compareSessionsByUpdatedAtDesc);
  const archivedSessions = sessions
    .filter((session) => session.archivedAt)
    .sort(compareSessionsByArchivedAtDesc);

  const chatBaseSessions =
    chatViewMode === "archived" ? archivedSessions : visibleSessions;
  const chatSessions = chatBaseSessions
    .filter((session) => sessionMatchesQuery(session, search))
    .filter(
      (session) =>
        chatViewMode !== "unread" || sessionStateById[session.id]?.hasUnread,
    );
  const chatWeekGroups =
    chatViewMode === "week" ? groupPrototypeChatsByWeek(chatSessions) : [];
  const emptyChatListMessage =
    chatViewMode === "unread"
      ? "No unread chats"
      : chatViewMode === "archived"
        ? "No archived chats"
        : "No chats found";
  const projectsById = new Map(
    projects.map((candidate) => [candidate.id, candidate]),
  );
  const project =
    secondaryTarget?.kind === "project"
      ? (projects.find(
          (candidate) => candidate.id === secondaryTarget.projectId,
        ) ?? null)
      : null;
  const projectId = project?.id ?? null;
  const previousProjectIdRef = useRef<string | null>(projectId);
  const missingProjectTarget = secondaryTarget?.kind === "project" && !project;

  useEffect(() => {
    if (missingProjectTarget) {
      onNavigate?.("home");
    }
  }, [missingProjectTarget, onNavigate]);

  useEffect(() => {
    if (previousProjectIdRef.current === projectId) return;
    previousProjectIdRef.current = projectId;
    setSelectedPrototypeChatId(null);
  }, [projectId]);

  const projectSessions = project
    ? visibleSessions.filter((session) => session.projectId === project.id)
    : [];
  const isUnsavedDefaultProjectSession = (session: ChatSession) =>
    session.messageCount === 0 &&
    getDisplaySessionTitle(session.title, defaultSessionTitle) ===
      defaultSessionTitle;
  const isUnsavedDefaultProjectChat = (chat: PrototypeProjectChatItem) =>
    chat.placeholder ||
    (chat.session ? isUnsavedDefaultProjectSession(chat.session) : false);
  const projectSessionsById = new Map(
    projectSessions.map((session) => [session.id, session]),
  );
  const projectSessionsByClientId = new Map(
    projectSessions
      .filter((session) => session.clientSessionId)
      .map((session) => [session.clientSessionId as string, session]),
  );
  const {
    groups: baseProjectGroups,
    ungroupedSessions: baseUngroupedSessions,
  } = groupPrototypeProjectSessions(project, projectSessions);
  const deletedProjectChatIdSet = new Set(
    Object.entries(deletedProjectChatIds)
      .filter(([, deleted]) => deleted)
      .map(([chatId]) => chatId),
  );
  const customGroupsForProject = project
    ? (customProjectGroups[project.id] ?? [])
    : [];
  const renamedGroupNamesForProject = project
    ? (renamedProjectGroupNames[project.id] ?? {})
    : {};
  const projectChatPlacementsForProject = project
    ? (projectChatPlacements[project.id] ?? {})
    : {};
  const placedProjectChatIds = new Set(
    Object.keys(projectChatPlacementsForProject),
  );
  const placedProjectChatsByGroup = new Map<
    string,
    PrototypeProjectChatItem[]
  >();
  const placedUngroupedProjectChats: PrototypeProjectChatItem[] = [];
  const deletedGroupChats: PrototypeProjectChatItem[] = [];

  Object.values(projectChatPlacementsForProject).forEach((placement) => {
    const resolvedSession =
      projectSessionsById.get(placement.chat.id) ??
      projectSessionsByClientId.get(placement.chat.id) ??
      null;
    const chat = resolvedSession
      ? {
          ...placement.chat,
          id: resolvedSession.id,
          session: resolvedSession,
          title: resolvedSession.title,
        }
      : placement.chat;
    placedProjectChatIds.add(chat.id);
    if (resolvedSession?.clientSessionId) {
      placedProjectChatIds.add(resolvedSession.clientSessionId);
    }

    if (deletedProjectChatIdSet.has(chat.id)) return;

    if (placement.groupId === null) {
      placedUngroupedProjectChats.push(chat);
      return;
    }

    const placedChats = placedProjectChatsByGroup.get(placement.groupId) ?? [];
    placedChats.push(chat);
    placedProjectChatsByGroup.set(placement.groupId, placedChats);
  });

  const visibleCustomProjectGroups = customGroupsForProject
    .map((group) => {
      const chats = [
        ...(placedProjectChatsByGroup.get(group.id) ?? []),
        ...group.chats.filter(
          (chat) =>
            !deletedProjectChatIdSet.has(chat.id) &&
            !placedProjectChatIds.has(chat.id),
        ),
      ];

      if (deletedProjectGroupIds[group.id]) {
        deletedGroupChats.push(...chats);
      }

      return {
        ...group,
        name: renamedGroupNamesForProject[group.id] ?? group.name,
        chats,
      };
    })
    .filter(
      (group) =>
        !deletedProjectGroupIds[group.id] &&
        (group.chats.length > 0 || group.id.includes(":custom-group:")),
    );
  const projectGroups = [
    ...visibleCustomProjectGroups,
    ...baseProjectGroups
      .map((group) => {
        const chats = [
          ...(placedProjectChatsByGroup.get(group.id) ?? []),
          ...group.chats.filter(
            (chat) =>
              !deletedProjectChatIdSet.has(chat.id) &&
              !placedProjectChatIds.has(chat.id),
          ),
        ];

        if (deletedProjectGroupIds[group.id]) {
          deletedGroupChats.push(...chats);
        }

        return {
          ...group,
          name: renamedGroupNamesForProject[group.id] ?? group.name,
          chats,
        };
      })
      .filter((group) => !deletedProjectGroupIds[group.id]),
  ];
  const ungroupedChats = [
    ...placedUngroupedProjectChats.filter(
      (chat) => !isUnsavedDefaultProjectChat(chat),
    ),
    ...deletedGroupChats.filter((chat) => !isUnsavedDefaultProjectChat(chat)),
    ...baseUngroupedSessions
      .filter(
        (session) =>
          !deletedProjectChatIdSet.has(session.id) &&
          !placedProjectChatIds.has(session.id),
      )
      .map(
        (session): PrototypeProjectChatItem => ({
          id: session.id,
          session,
          title: session.title,
        }),
      ),
  ];
  const topLevelProjectDraftChats = ungroupedChats.filter(
    isUnsavedDefaultProjectChat,
  );
  const activeTopLevelProjectDraftChat =
    topLevelProjectDraftChats.find(
      (chat) => chat.session?.id === activeSessionId,
    ) ?? null;
  const hasRealProjectChats =
    projectGroups.some((group) => group.chats.length > 0) ||
    ungroupedChats.some((chat) => !isUnsavedDefaultProjectChat(chat));
  const hasAnyProjectListContent =
    projectGroups.length > 0 || ungroupedChats.length > 0;
  const visibleTopLevelProjectDraftChat =
    activeTopLevelProjectDraftChat ??
    (!hasRealProjectChats ? (topLevelProjectDraftChats[0] ?? null) : null);
  const projectNewChatRow: PrototypeProjectChatItem | null = project
    ? (visibleTopLevelProjectDraftChat ??
      (!hasAnyProjectListContent
        ? {
            id: `${project.id}:interim-new-chat`,
            placeholder: true,
            session: null,
            title: defaultSessionTitle,
          }
        : null))
    : null;
  const hiddenTopLevelProjectDraftIds = new Set(
    topLevelProjectDraftChats
      .filter((chat) => chat.id !== visibleTopLevelProjectDraftChat?.id)
      .map((chat) => chat.id),
  );
  const visibleUngroupedChats = projectNewChatRow
    ? [
        projectNewChatRow,
        ...ungroupedChats.filter(
          (chat) =>
            chat.id !== projectNewChatRow.id &&
            !hiddenTopLevelProjectDraftIds.has(chat.id),
        ),
      ]
    : ungroupedChats.filter(
        (chat) => !hiddenTopLevelProjectDraftIds.has(chat.id),
      );
  const projectNewChatRowIsOnlyVisibleRow =
    Boolean(projectNewChatRow) &&
    projectGroups.length === 0 &&
    visibleUngroupedChats.length === 1;
  const currentPersistedProjectGroups = project?.chatGroups?.groups ?? [];
  const getProjectChatMetadataId = (chat: PrototypeProjectChatItem) =>
    chat.session?.id ?? chat.id;
  const getProjectChatMetadataIds = (chat: PrototypeProjectChatItem) =>
    new Set(
      [chat.id, chat.session?.id, chat.session?.clientSessionId].filter(
        (id): id is string => typeof id === "string",
      ),
    );
  const persistProjectChatGroups = (
    projectId: string,
    groups: ProjectChatGroupMetadata[],
    fallback: () => void,
  ) => {
    if (!onUpdateProjectChatGroups) {
      fallback();
      return;
    }

    const chatGroups = groups.length > 0 ? { groups } : null;
    void Promise.resolve(
      onUpdateProjectChatGroups(projectId, chatGroups),
    ).catch((error) => {
      console.error("Failed to update project chat groups:", error);
    });
  };
  const removeChatFromPersistedGroups = (
    groups: ProjectChatGroupMetadata[],
    chat: PrototypeProjectChatItem,
  ) => {
    const chatIds = getProjectChatMetadataIds(chat);
    return groups.map((group) => ({
      ...group,
      chatIds: group.chatIds.filter((chatId) => !chatIds.has(chatId)),
    }));
  };

  const toggleProjectGroup = (groupId: string) => {
    onCommitPreview?.();
    setExpandedProjectGroupIds((current) => ({
      ...current,
      [groupId]: !(current[groupId] ?? true),
    }));
  };
  const selectPrototypeChat = (
    chat: PrototypeProjectChatItem,
    groupName: string,
  ) => {
    if (!project) return;
    onSecondarySelect?.();
    onCommitPreview?.();
    if (chat.placeholder) {
      if (chat.id === projectNewChatRow?.id) {
        setSelectedPrototypeChatId(null);
        onNewChatInProject?.(project.id, { reuseExistingDraft: true });
        return;
      }
      setSelectedPrototypeChatId(chat.id);
      return;
    }

    const messages = getPrototypeChatMessages({
      chat,
      groupName,
      projectName: project.name,
    });
    const now = new Date().toISOString();
    useChatSessionStore.getState().addSession({
      id: chat.id,
      title: chat.title,
      projectId: project.id,
      createdAt: now,
      updatedAt: now,
      messageCount: messages.length,
      subtitle: groupName,
      userSetName: true,
    });
    useChatStore.getState().setMessages(chat.id, messages);
    setSelectedPrototypeChatId(chat.id);
    onSelectSession?.(chat.id);
  };
  const selectRealSession = (sessionId: string) => {
    onSecondarySelect?.();
    onCommitPreview?.();
    setSelectedPrototypeChatId(null);
    onSelectSession?.(sessionId);
  };
  const startNewChatInProjectGroup = async (group: PrototypeProjectGroup) => {
    if (!project || !onNewChatInProject) return;

    onCommitPreview?.();
    const session = await Promise.resolve(
      onNewChatInProject(project.id, { reuseExistingDraft: false }),
    );
    if (!session) return;

    const chat: PrototypeProjectChatItem = {
      id: session.id,
      session,
      title: session.title,
    };

    if (onUpdateProjectChatGroups) {
      const nextGroups = currentPersistedProjectGroups.map((candidate) =>
        candidate.id === group.id
          ? {
              ...candidate,
              chatIds: [
                ...candidate.chatIds.filter((chatId) => chatId !== chat.id),
                chat.id,
              ],
            }
          : candidate,
      );
      persistProjectChatGroups(project.id, nextGroups, () => {});
      setExpandedProjectGroupIds((current) => ({
        ...current,
        [group.id]: true,
      }));
      return;
    }

    setProjectChatPlacements((current) => ({
      ...current,
      [project.id]: {
        ...(current[project.id] ?? {}),
        [chat.id]: {
          chat,
          groupId: group.id,
        },
      },
    }));
    setExpandedProjectGroupIds((current) => ({
      ...current,
      [group.id]: true,
    }));
  };
  const closeCreateGroupDialog = () => {
    setGroupDialogChat(null);
    setGroupNameDraft("");
  };
  const openCreateGroupDialog = (chat: PrototypeProjectChatItem) => {
    if (!project) return;
    if (chat.placeholder || isUnsavedDefaultProjectChat(chat)) return;
    onCommitPreview?.();
    setGroupDialogChat({
      projectId: project.id,
      chat,
    });
    setGroupNameDraft("");
  };
  const closeRenameGroupDialog = () => {
    setRenameGroupDialog(null);
    setGroupNameDraft("");
  };
  const openRenameGroupDialog = (group: PrototypeProjectGroup) => {
    if (!project) return;
    onCommitPreview?.();
    setRenameGroupDialog({
      projectId: project.id,
      groupId: group.id,
    });
    setGroupNameDraft(group.name);
  };
  const renameProjectGroup = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!renameGroupDialog) return;

    const groupName = groupNameDraft.trim();
    if (!groupName) return;

    const { groupId, projectId } = renameGroupDialog;
    persistProjectChatGroups(
      projectId,
      currentPersistedProjectGroups.map((group) =>
        group.id === groupId ? { ...group, name: groupName } : group,
      ),
      () => {
        setRenamedProjectGroupNames((current) => ({
          ...current,
          [projectId]: {
            ...(current[projectId] ?? {}),
            [groupId]: groupName,
          },
        }));
      },
    );
    closeRenameGroupDialog();
    return;
  };
  const deleteProjectGroup = (group: PrototypeProjectGroup) => {
    if (!project) return;

    onCommitPreview?.();
    persistProjectChatGroups(
      project.id,
      currentPersistedProjectGroups.filter(
        (candidate) => candidate.id !== group.id,
      ),
      () => {
        setDeletedProjectGroupIds((current) => ({
          ...current,
          [group.id]: true,
        }));
        setProjectChatPlacements((current) => {
          const currentProjectPlacements = current[project.id] ?? {};
          return {
            ...current,
            [project.id]: {
              ...currentProjectPlacements,
              ...Object.fromEntries(
                group.chats.map((chat) => [
                  chat.id,
                  {
                    chat,
                    groupId: null,
                  },
                ]),
              ),
            },
          };
        });
      },
    );
    setExpandedProjectGroupIds((current) => {
      const { [group.id]: _removedGroup, ...next } = current;
      return next;
    });
  };
  const createProjectGroup = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!groupDialogChat) return;

    const groupName = groupNameDraft.trim();
    if (!groupName) return;

    const { chat, projectId } = groupDialogChat;
    if (chat.placeholder || isUnsavedDefaultProjectChat(chat)) {
      closeCreateGroupDialog();
      return;
    }
    const groupId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? `${projectId}:chat-group:${crypto.randomUUID()}`
        : `${projectId}:chat-group:${chat.id}:${Date.now()}`;

    persistProjectChatGroups(
      projectId,
      [
        {
          id: groupId,
          name: groupName,
          chatIds: [getProjectChatMetadataId(chat)],
        },
        ...removeChatFromPersistedGroups(currentPersistedProjectGroups, chat),
      ],
      () => {
        setCustomProjectGroups((current) => {
          const currentProjectGroups = current[projectId] ?? [];
          const groupsWithoutChat = currentProjectGroups
            .map((group) => ({
              ...group,
              chats: group.chats.filter(
                (candidate) => candidate.id !== chat.id,
              ),
            }))
            .filter((group) => group.chats.length > 0);

          return {
            ...current,
            [projectId]: [
              {
                id: groupId,
                name: groupName,
                chats: [],
              },
              ...groupsWithoutChat,
            ],
          };
        });
        setProjectChatPlacements((current) => ({
          ...current,
          [projectId]: {
            ...(current[projectId] ?? {}),
            [chat.id]: {
              chat,
              groupId,
            },
          },
        }));
      },
    );
    setExpandedProjectGroupIds((current) => ({
      ...current,
      [groupId]: true,
    }));
    closeCreateGroupDialog();
  };
  const deleteProjectChat = (chat: PrototypeProjectChatItem) => {
    onCommitPreview?.();
    const removeProjectChat = () => {
      if (project) {
        persistProjectChatGroups(
          project.id,
          removeChatFromPersistedGroups(currentPersistedProjectGroups, chat),
          () => {},
        );
      }
      setDeletedProjectChatIds((current) => ({
        ...current,
        [chat.id]: true,
      }));
      setProjectChatPlacements((current) => {
        if (!project) return current;
        const currentProjectPlacements = current[project.id] ?? {};
        if (!currentProjectPlacements[chat.id]) return current;

        const { [chat.id]: _removedChatPlacement, ...nextProjectPlacements } =
          currentProjectPlacements;

        return {
          ...current,
          [project.id]: nextProjectPlacements,
        };
      });
      setCustomProjectGroups((current) => {
        if (!project) return current;
        const currentProjectGroups = current[project.id] ?? [];
        if (currentProjectGroups.length === 0) return current;

        return {
          ...current,
          [project.id]: currentProjectGroups
            .map((group) => ({
              ...group,
              chats: group.chats.filter(
                (candidate) => candidate.id !== chat.id,
              ),
            }))
            .filter((group) => group.chats.length > 0),
        };
      });
      if (selectedPrototypeChatId === chat.id) {
        setSelectedPrototypeChatId(null);
      }
    };

    if (!chat.session) {
      removeProjectChat();
      return;
    }

    if (chat.session) {
      const sessionId = chat.session.id;
      const archiveProjectChat = async () => {
        if (onArchiveChat) {
          const result = await onArchiveChat(sessionId);
          if (archiveChatSucceeded(result)) {
            removeProjectChat();
          }
          return;
        }
        await useChatSessionStore.getState().archiveSession(sessionId);
        removeProjectChat();
      };
      void archiveProjectChat().catch((error) => {
        console.error("Failed to archive project chat:", error);
      });
    }
  };
  const selectSettingsSection = (section: SectionId) => {
    onSecondarySelect?.();
    onCommitPreview?.();
    onOpenSettingsSection?.(section);
  };

  return (
    <>
      <PaneSurface
        testId="sidebar-prototype-secondary-panel"
        className="-ml-px h-full rounded-l-none"
        fullHeight
        glass={false}
        width={width}
      >
        {secondaryTarget?.kind === "chats" ? (
          <nav aria-label="Chats" className={NAV_PROTOTYPE_PANEL_CONTENT_CLASS}>
            <label
              className={cn(
                "relative mb-3 block",
                NAV_PROTOTYPE_TEXT_DEFAULT_CLASS,
              )}
            >
              <Search
                className={cn(
                  "pointer-events-none absolute left-3 top-1/2 -translate-y-1/2",
                  NAV_PROTOTYPE_LUCIDE_ICON_CLASS,
                  NAV_PROTOTYPE_ICON_CLASS,
                )}
              />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("actions.search")}
                className="h-7 w-full rounded-sm bg-muted/60 pl-9 pr-9 text-sm font-normal outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-sidebar-ring"
              />
              <DropdownMenu
                onOpenChange={(open) => {
                  onNavigationMenuOpenChange?.(open);
                  if (open) {
                    onCommitPreview?.();
                  }
                }}
              >
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Filter chats: ${PROTOTYPE_CHAT_VIEW_LABELS[chatViewMode]}`}
                    title={`Filter chats: ${PROTOTYPE_CHAT_VIEW_LABELS[chatViewMode]}`}
                    className={cn(
                      "absolute right-2 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center border-0 bg-transparent p-0 transition-colors duration-150 focus-visible:outline-none",
                      NAV_PROTOTYPE_ACTION_ICON_CLASS,
                    )}
                  >
                    <ListFilter className={NAV_PROTOTYPE_LUCIDE_ICON_CLASS} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  side="bottom"
                  sideOffset={8}
                  variant="inverse"
                  className={cn(
                    "w-36 rounded-[10px]",
                    NAV_PROTOTYPE_MENU_CONTENT_CLASS,
                  )}
                >
                  {Object.entries(PROTOTYPE_CHAT_VIEW_LABELS).map(
                    ([mode, label]) => (
                      <PrototypeChatFilterMenuItem
                        key={mode}
                        active={mode === chatViewMode}
                        onSelect={() =>
                          setChatViewMode(mode as PrototypeChatViewMode)
                        }
                      >
                        {label}
                      </PrototypeChatFilterMenuItem>
                    ),
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </label>
            <div className="relative min-h-0 flex-1">
              <div
                className="h-full overflow-y-auto pb-10 scrollbar-none"
                style={PROTOTYPE_CHAT_LIST_BOTTOM_MASK_STYLE}
              >
                {chatViewMode === "week" ? (
                  <div className="space-y-2">
                    {chatWeekGroups.map((group) => (
                      <div key={group.id} className="space-y-px">
                        <div
                          className={cn(
                            "flex h-7 items-center px-3 text-sm font-normal leading-normal",
                            NAV_PROTOTYPE_SECTION_LABEL_CLASS,
                          )}
                        >
                          {group.label}
                        </div>
                        {group.sessions.map((session) => (
                          <PrototypeSessionRow
                            key={session.id}
                            active={activeSessionId === session.id}
                            project={
                              session.projectId
                                ? projectsById.get(session.projectId)
                                : null
                            }
                            session={session}
                            onSelect={selectRealSession}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-px">
                    {chatSessions.map((session) => (
                      <PrototypeSessionRow
                        key={session.id}
                        active={activeSessionId === session.id}
                        project={
                          session.projectId
                            ? projectsById.get(session.projectId)
                            : null
                        }
                        session={session}
                        onSelect={selectRealSession}
                      />
                    ))}
                  </div>
                )}
                {chatSessions.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-muted-foreground/70">
                    {emptyChatListMessage}
                  </div>
                ) : null}
              </div>
            </div>
          </nav>
        ) : secondaryTarget?.kind === "settings" ? (
          <nav
            aria-label={t("settings:navigationLabel")}
            className={NAV_PROTOTYPE_PANEL_CONTENT_CLASS}
          >
            <div className="relative min-h-0 flex-1">
              <div className="h-full overflow-y-auto pb-10 scrollbar-none">
                <div className="space-y-px">
                  {settingsSections.map((section) => {
                    const Icon = section.icon;
                    const active = activeSettingsSection === section.id;
                    return (
                      <button
                        key={section.id}
                        type="button"
                        onClick={() => selectSettingsSection(section.id)}
                        className={cn(
                          "group flex h-7 w-full items-center gap-2 rounded-sm px-3 text-left text-sm transition-colors duration-150",
                          active
                            ? NAV_PROTOTYPE_ROW_ACTIVE_CLASS
                            : cn(
                                NAV_PROTOTYPE_TEXT_DEFAULT_CLASS,
                                NAV_PROTOTYPE_ROW_HOVER_CLASS,
                              ),
                        )}
                      >
                        <Icon
                          className={cn(
                            "shrink-0 transition-colors duration-150",
                            NAV_PROTOTYPE_LUCIDE_ICON_CLASS,
                            NAV_PROTOTYPE_ICON_CLASS,
                          )}
                        />
                        <span className="min-w-0 truncate">
                          {t(`settings:${section.labelKey}`)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </nav>
        ) : missingProjectTarget ? null : (
          <nav
            aria-label={project ? `${project.name} project chats` : "Project"}
            className={NAV_PROTOTYPE_PANEL_CONTENT_CLASS}
          >
            {project ? (
              <div className="relative min-h-0 flex-1">
                <div
                  className="h-full overflow-y-auto pb-10 scrollbar-none"
                  style={PROTOTYPE_CHAT_LIST_BOTTOM_MASK_STYLE}
                >
                  <div className="flex min-h-full flex-col gap-px">
                    {projectGroups.map((group) => {
                      const expanded =
                        expandedProjectGroupIds[group.id] ?? true;
                      return (
                        <div key={group.id} className="space-y-px">
                          <PrototypeProjectGroupRow
                            group={group}
                            expanded={expanded}
                            onDeleteGroup={() => deleteProjectGroup(group)}
                            onMenuOpenChange={(open) => {
                              onNavigationMenuOpenChange?.(open);
                              if (open) {
                                onCommitPreview?.();
                              }
                            }}
                            onNewChat={() => startNewChatInProjectGroup(group)}
                            onRenameGroup={() => openRenameGroupDialog(group)}
                            onToggle={() => toggleProjectGroup(group.id)}
                          />
                          <div
                            className={cn(
                              "overflow-hidden transition-[max-height,opacity,transform] duration-200 ease-out",
                              expanded
                                ? "translate-y-0 opacity-100"
                                : "pointer-events-none -translate-y-1 opacity-0",
                            )}
                            style={{
                              maxHeight: expanded
                                ? getPrototypeRowsMaxHeight(group.chats.length)
                                : 0,
                            }}
                            aria-hidden={expanded ? undefined : true}
                            inert={expanded ? undefined : true}
                          >
                            <div className="space-y-px">
                              {group.chats.map((chat) => (
                                <PrototypeProjectChatRow
                                  key={chat.id}
                                  active={
                                    chat.session
                                      ? chat.session.id === activeSessionId
                                      : chat.id === selectedPrototypeChatId ||
                                        chat.id === activeSessionId
                                  }
                                  chat={chat}
                                  nested
                                  onCreateGroup={openCreateGroupDialog}
                                  onDelete={deleteProjectChat}
                                  onMenuOpenChange={(open) => {
                                    onNavigationMenuOpenChange?.(open);
                                    if (open) {
                                      onCommitPreview?.();
                                    }
                                  }}
                                  onPrototypeSelect={(prototypeChat) =>
                                    selectPrototypeChat(
                                      prototypeChat,
                                      group.name,
                                    )
                                  }
                                  onSelect={selectRealSession}
                                />
                              ))}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    <fieldset
                      aria-label="Ungrouped project chats"
                      className="m-0 min-w-0 flex-1 space-y-px rounded-sm border-0 p-0"
                    >
                      {visibleUngroupedChats.map((chat) => (
                        <PrototypeProjectChatRow
                          key={chat.id}
                          active={
                            chat.session
                              ? activeSessionId === chat.session.id
                              : chat.id === selectedPrototypeChatId ||
                                chat.id === activeSessionId
                          }
                          chat={chat}
                          onCreateGroup={openCreateGroupDialog}
                          onDelete={deleteProjectChat}
                          onMenuOpenChange={(open) => {
                            onNavigationMenuOpenChange?.(open);
                            if (open) {
                              onCommitPreview?.();
                            }
                          }}
                          onPrototypeSelect={(prototypeChat) =>
                            selectPrototypeChat(prototypeChat, "Ungrouped")
                          }
                          onSelect={selectRealSession}
                          showPlaceholderIcon={
                            chat.id === projectNewChatRow?.id &&
                            projectNewChatRowIsOnlyVisibleRow
                          }
                        />
                      ))}
                    </fieldset>
                  </div>
                </div>
              </div>
            ) : (
              <div className="px-3 py-2 text-sm text-muted-foreground/70">
                Select a project
              </div>
            )}
            {!project && onCreateProject ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={onCreateProject}
                className={cn("mt-2 justify-start", NAV_PROTOTYPE_ICON_CLASS)}
              >
                <Plus className={NAV_PROTOTYPE_LUCIDE_ICON_CLASS} />
                {t("actions.newProject")}
              </Button>
            ) : null}
          </nav>
        )}
      </PaneSurface>
      <Dialog
        open={groupDialogChat !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeCreateGroupDialog();
          }
        }}
      >
        <DialogContent className="max-w-[560px] gap-0 overflow-hidden p-0">
          <form onSubmit={createProjectGroup}>
            <DialogHeader className="px-6 pb-4 pt-6">
              <DialogTitle>Set group name</DialogTitle>
              <DialogDescription className="sr-only">
                Name the chat group to create in this project.
              </DialogDescription>
            </DialogHeader>
            <div className="px-6 pb-6">
              <label
                htmlFor="prototype-project-group-name"
                className="mb-2 block text-sm text-foreground"
              >
                Group name
              </label>
              <input
                id="prototype-project-group-name"
                value={groupNameDraft}
                onChange={(event) => setGroupNameDraft(event.target.value)}
                autoFocus
                className="h-12 w-full rounded-sm border border-border bg-background px-4 text-sm text-foreground outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <DialogFooter className="border-t border-border/70 px-6 py-4">
              <Button
                type="submit"
                disabled={groupNameDraft.trim().length === 0}
                className="min-w-24"
              >
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={renameGroupDialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeRenameGroupDialog();
          }
        }}
      >
        <DialogContent className="max-w-[560px] gap-0 overflow-hidden p-0">
          <form onSubmit={renameProjectGroup}>
            <DialogHeader className="px-6 pb-4 pt-6">
              <DialogTitle>Rename group</DialogTitle>
              <DialogDescription className="sr-only">
                Rename this project chat group.
              </DialogDescription>
            </DialogHeader>
            <div className="px-6 pb-6">
              <label
                htmlFor="prototype-project-rename-group-name"
                className="mb-2 block text-sm text-foreground"
              >
                Group name
              </label>
              <input
                id="prototype-project-rename-group-name"
                value={groupNameDraft}
                onChange={(event) => setGroupNameDraft(event.target.value)}
                autoFocus
                className="h-12 w-full rounded-sm border border-border bg-background px-4 text-sm text-foreground outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <DialogFooter className="border-t border-border/70 px-6 py-4">
              <Button
                type="submit"
                disabled={groupNameDraft.trim().length === 0}
                className="min-w-24"
              >
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function NavigationPanesView({
  collapsed,
  width,
  isResizing = false,
  elevatedShadow = false,
  onSettingsClick,
  onOpenSettingsSection,
  onSettingsBack,
  onSettingsSectionChange,
  onNewChatInProject,
  onNewChat,
  onCreateProject,
  onEditProject,
  onArchiveProject,
  onUpdateProjectChatGroups,
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
  activeSessionId,
  detachableSessionListEnabled = false,
  paneSizes,
  onPaneResizeBegin,
  onPaneResizeEnd,
  onPaneResize,
  sessionListDock = "stacked",
  onSessionListDragRelease,
  getSessionListDragPreviewDock,
  prototypeMode = null,
  prototypePrimaryCollapsed = false,
  onPrototypePrimaryHoverChange,
  prototypeSecondaryTarget = null,
  onPrototypeSecondaryTargetChange,
  onPrototypeSecondarySelect,
  onPrototypeSecondaryPreviewChange,
  prototypePrimaryWidth = width,
  prototypeSecondaryWidth = NAV_PROTOTYPE_SECONDARY_WIDTH_PX,
  prototypePrimaryOverlaysContent = false,
  prototypeSecondaryPush = false,
  className,
  projects,
}: NavigationPanesViewProps) {
  const { t } = useTranslation(["sidebar", "common", "settings"]);
  const agentUpdatesAvailable = useAgentUpdatesAvailable();
  const navRef = useRef<HTMLElement>(null);
  const primaryNavPanelRef = useRef<HTMLDivElement>(null);
  const prototypeSecondaryPanelRef = useRef<HTMLDivElement>(null);
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
  const [prototypeChatSearch, setPrototypeChatSearch] = useState("");
  const [prototypePreviewTarget, setPrototypePreviewTarget] =
    useState<NavigationSecondaryTarget>(null);
  const [
    renderedPrototypeSecondaryTarget,
    setRenderedPrototypeSecondaryTarget,
  ] = useState<NavigationSecondaryTarget>(prototypeSecondaryTarget);
  const [prototypeSecondaryClosing, setPrototypeSecondaryClosing] =
    useState(false);
  const [prototypeAnnouncementDismissed, setPrototypeAnnouncementDismissed] =
    useState(readPrototypeNavigationAnnouncementDismissed);
  const prototypePreviewCloseTimeoutRef = useRef<number | null>(null);
  const prototypePrimaryHoverRef = useRef(false);
  const prototypeSecondaryHoverRef = useRef(false);
  const prototypeNavMenuOpenRef = useRef(false);
  const dismissPrototypeAnnouncement = useCallback(() => {
    setPrototypeAnnouncementDismissed(true);
    writePrototypeNavigationAnnouncementDismissed();
  }, []);
  const collapsePrototypePrimary = useCallback(() => {
    if (prototypeNavMenuOpenRef.current) return;

    prototypePrimaryHoverRef.current = false;
    onPrototypePrimaryHoverChange?.(false);
  }, [onPrototypePrimaryHoverChange]);
  const sessions = useChatSessionStore(selectSessions);
  const handleSessionSelectForScroll = useCallback((sessionId: string) => {
    skipActiveSessionScrollRef.current = sessionId;
  }, []);

  const isPrototype = Boolean(prototypeMode);

  useEffect(() => {
    if (!isPrototype) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        target instanceof Element &&
        target.closest('[data-prototype-nav-menu-trigger="true"]')
      ) {
        prototypeNavMenuOpenRef.current = true;
        return;
      }
      if (prototypeNavMenuOpenRef.current) return;
      if (primaryNavPanelRef.current?.contains(target)) return;
      if (prototypeSecondaryPanelRef.current?.contains(target)) return;
      collapsePrototypePrimary();
    };

    document.addEventListener("pointerdown", handlePointerDown, {
      capture: true,
    });
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, {
        capture: true,
      });
    };
  }, [collapsePrototypePrimary, isPrototype]);

  const labelVisible = !collapsed;
  const labelTransition = "";
  const canDetachSessionList =
    !isPrototype && detachableSessionListEnabled && !collapsed;
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
  const isSecondarySurface = activeView === "settings";
  const shouldSkipActiveSessionScroll =
    activeSessionId !== null &&
    skipActiveSessionScrollRef.current === activeSessionId;
  const prototypeSecondaryRendered = renderedPrototypeSecondaryTarget !== null;
  const prototypeSecondaryInline =
    prototypeSecondaryRendered &&
    prototypeSecondaryPush &&
    !prototypePrimaryOverlaysContent;
  const prototypeSecondaryOverlay =
    prototypeSecondaryRendered && !prototypeSecondaryInline;
  const prototypeSidebarBasePrimaryWidth = prototypePrimaryOverlaysContent
    ? NAV_PROTOTYPE_PRIMARY_COLLAPSED_WIDTH_PX
    : prototypePrimaryWidth;
  const prototypeSidebarContentWidth =
    prototypeSidebarBasePrimaryWidth +
    (prototypeSecondaryRendered && prototypeSecondaryPush
      ? NAV_PROTOTYPE_PANEL_GAP_PX +
        prototypeSecondaryWidth -
        NAV_PROTOTYPE_PANEL_OVERLAP_PX
      : 0);
  const prototypeSidebarGlassWidth =
    prototypePrimaryWidth +
    (prototypeSecondaryRendered
      ? NAV_PROTOTYPE_PANEL_GAP_PX +
        prototypeSecondaryWidth -
        NAV_PROTOTYPE_PANEL_OVERLAP_PX
      : 0);
  const activePrototypeSession =
    activeView === "chat" && activeSessionId
      ? (sessions.find((session) => session.id === activeSessionId) ?? null)
      : null;
  const activePrototypeSecondaryTarget: NavigationSecondaryTarget =
    activeView === "chat" && activePrototypeSession
      ? activePrototypeSession.projectId
        ? { kind: "project", projectId: activePrototypeSession.projectId }
        : { kind: "chats" }
      : null;
  const activePrototypeProjectId = activePrototypeSession?.projectId ?? null;

  const clearPrototypePreviewCloseTimeout = useCallback(() => {
    if (prototypePreviewCloseTimeoutRef.current === null) return;
    window.clearTimeout(prototypePreviewCloseTimeoutRef.current);
    prototypePreviewCloseTimeoutRef.current = null;
  }, []);

  const openPrototypeSecondary = useCallback(
    (
      target: NavigationSecondaryTarget,
      options: { preview?: boolean } = {},
    ) => {
      clearPrototypePreviewCloseTimeout();
      const targetAlreadyOpen = navigationSecondaryTargetsEqual(
        target,
        prototypeSecondaryTarget,
      );
      const targetIsCurrentPreview =
        prototypePreviewTarget !== null &&
        navigationSecondaryTargetsEqual(target, prototypePreviewTarget);
      const shouldPreview = Boolean(
        options.preview && (!targetAlreadyOpen || targetIsCurrentPreview),
      );

      setPrototypePreviewTarget(shouldPreview ? target : null);
      onPrototypeSecondaryPreviewChange?.(shouldPreview);
      onPrototypeSecondaryTargetChange?.(target);
    },
    [
      clearPrototypePreviewCloseTimeout,
      onPrototypeSecondaryPreviewChange,
      onPrototypeSecondaryTargetChange,
      prototypePreviewTarget,
      prototypeSecondaryTarget,
    ],
  );
  const commitPrototypePreview = useCallback(() => {
    clearPrototypePreviewCloseTimeout();
    setPrototypePreviewTarget(null);
    onPrototypeSecondaryPreviewChange?.(false);
  }, [clearPrototypePreviewCloseTimeout, onPrototypeSecondaryPreviewChange]);
  const closePrototypePreview = useCallback(() => {
    clearPrototypePreviewCloseTimeout();
    const previewMatchesActiveChat =
      prototypePreviewTarget &&
      navigationSecondaryTargetsEqual(
        prototypePreviewTarget,
        prototypeSecondaryTarget,
      ) &&
      navigationSecondaryTargetsEqual(
        prototypePreviewTarget,
        activePrototypeSecondaryTarget,
      );

    if (previewMatchesActiveChat) {
      setPrototypePreviewTarget(null);
      onPrototypeSecondaryPreviewChange?.(false);
      onPrototypeSecondarySelect?.();
      return;
    }

    if (
      prototypePreviewTarget &&
      navigationSecondaryTargetsEqual(
        prototypePreviewTarget,
        prototypeSecondaryTarget,
      )
    ) {
      onPrototypeSecondaryTargetChange?.(null);
    }
    setPrototypePreviewTarget(null);
    onPrototypeSecondaryPreviewChange?.(false);
  }, [
    activePrototypeSecondaryTarget,
    clearPrototypePreviewCloseTimeout,
    onPrototypeSecondaryPreviewChange,
    onPrototypeSecondarySelect,
    onPrototypeSecondaryTargetChange,
    prototypePreviewTarget,
    prototypeSecondaryTarget,
  ]);
  const schedulePrototypePreviewClose = useCallback(() => {
    clearPrototypePreviewCloseTimeout();
    prototypePreviewCloseTimeoutRef.current = window.setTimeout(() => {
      prototypePreviewCloseTimeoutRef.current = null;
      if (
        prototypePrimaryHoverRef.current ||
        prototypeSecondaryHoverRef.current
      ) {
        return;
      }
      closePrototypePreview();
    }, 120);
  }, [clearPrototypePreviewCloseTimeout, closePrototypePreview]);

  useEffect(
    () => () => {
      clearPrototypePreviewCloseTimeout();
    },
    [clearPrototypePreviewCloseTimeout],
  );

  useEffect(() => {
    if (prototypeSecondaryTarget) {
      setRenderedPrototypeSecondaryTarget(prototypeSecondaryTarget);
      setPrototypeSecondaryClosing(false);
      return;
    }

    if (!renderedPrototypeSecondaryTarget) {
      setPrototypeSecondaryClosing(false);
      return;
    }

    setPrototypeSecondaryClosing(true);
    const timeoutId = window.setTimeout(() => {
      setRenderedPrototypeSecondaryTarget(null);
      setPrototypeSecondaryClosing(false);
    }, NAV_PROTOTYPE_SECONDARY_EXIT_MS);

    return () => window.clearTimeout(timeoutId);
  }, [prototypeSecondaryTarget, renderedPrototypeSecondaryTarget]);

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
      onArchiveChat={
        onArchiveChat
          ? (sessionId) =>
              Promise.resolve(onArchiveChat(sessionId)).then(() => undefined)
          : undefined
      }
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

  if (isPrototype && prototypeMode) {
    const secondaryPanel = renderedPrototypeSecondaryTarget ? (
      <div
        ref={prototypeSecondaryPanelRef}
        className={cn(
          "relative h-full flex-shrink-0 overflow-visible",
          prototypeSecondaryClosing && "pointer-events-none",
        )}
        onClickCapture={() => {
          if (!prototypeNavMenuOpenRef.current) {
            collapsePrototypePrimary();
          }
        }}
        onPointerEnter={() => {
          clearPrototypePreviewCloseTimeout();
          prototypeSecondaryHoverRef.current = true;
        }}
        onPointerLeave={(event) => {
          const movingToPrimary = eventTargetIsInsideElement(
            event.relatedTarget,
            primaryNavPanelRef.current,
          );
          prototypeSecondaryHoverRef.current = false;
          if (!movingToPrimary) {
            collapsePrototypePrimary();
          }
          schedulePrototypePreviewClose();
        }}
        style={{
          width: prototypeSecondaryWidth,
        }}
        aria-hidden={prototypeSecondaryClosing || undefined}
      >
        <div
          className={cn(
            "h-full transition-[opacity,transform] duration-200 ease-out will-change-transform",
            prototypeSecondaryClosing
              ? "-translate-x-3 opacity-0"
              : "translate-x-0 opacity-100",
          )}
        >
          <PrototypeSecondaryPanel
            activeSessionId={activeSessionId}
            activeSettingsSection={activeSettingsSection}
            onCreateProject={onCreateProject}
            onArchiveChat={onArchiveChat}
            onCommitPreview={commitPrototypePreview}
            onNavigationMenuOpenChange={(open) => {
              prototypeNavMenuOpenRef.current = open;
            }}
            onNavigate={onNavigate}
            onNewChatInProject={onNewChatInProject}
            onOpenSettingsSection={onOpenSettingsSection}
            onSecondarySelect={onPrototypeSecondarySelect}
            onSelectSession={onSelectSession}
            onUpdateProjectChatGroups={onUpdateProjectChatGroups}
            projects={projects}
            search={prototypeChatSearch}
            secondaryTarget={renderedPrototypeSecondaryTarget}
            sessions={sessions}
            settingsSections={visibleSettingsSections}
            setSearch={setPrototypeChatSearch}
            width={prototypeSecondaryWidth}
          />
        </div>
      </div>
    ) : null;
    const prototypeGlassUnderlay = (
      <div
        aria-hidden="true"
        data-testid="sidebar-prototype-glass-underlay"
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 z-0 rounded-md bg-sidebar",
          !prototypePrimaryCollapsed && "shadow-sidebar-panel-elevated",
          NAV_PROTOTYPE_TRANSITION_CLASS,
        )}
        style={{
          backdropFilter: "var(--backdrop-sidebar-panel)",
          WebkitBackdropFilter: "var(--backdrop-sidebar-panel)",
          width: prototypeSidebarGlassWidth,
        }}
      />
    );

    const prototypeOverlays =
      prototypeSecondaryOverlay && secondaryPanel ? (
        <div
          className={cn(
            "absolute top-0 z-40 h-full",
            NAV_PROTOTYPE_TRANSITION_CLASS,
          )}
          style={{
            left: 0,
            transform: `translate3d(${
              prototypePrimaryWidth +
              NAV_PROTOTYPE_PANEL_GAP_PX -
              NAV_PROTOTYPE_PANEL_OVERLAP_PX
            }px, 0, 0)`,
            width: prototypeSecondaryWidth,
          }}
        >
          {secondaryPanel}
        </div>
      ) : null;

    const handlePrototypeNavigate = (view: AppView) => {
      setPrototypePreviewTarget(null);
      onPrototypeSecondaryPreviewChange?.(false);
      onPrototypeSecondaryTargetChange?.(null);
      onNavigate?.(view);
    };
    const openPrototypeChatsSecondary = (options?: { preview?: boolean }) => {
      openPrototypeSecondary({ kind: "chats" }, options);
    };
    const openPrototypeProjectSecondary = (
      projectId: string,
      options?: { preview?: boolean },
    ) => {
      openPrototypeSecondary({ kind: "project", projectId }, options);
    };
    const openPrototypeSettingsSecondary = (options?: {
      preview?: boolean;
    }) => {
      openPrototypeSecondary({ kind: "settings" }, options);
    };
    const selectPrototypeSettingsSecondary = () => {
      openPrototypeSettingsSecondary();
      onPrototypeSecondarySelect?.();
      onSettingsClick?.();
    };

    return (
      <PaneLayoutFrame
        className={cn(NAV_PROTOTYPE_TRANSITION_CLASS, className)}
        gapPx={NAV_PROTOTYPE_PANEL_GAP_PX}
        height="100%"
        onPointerEnter={clearPrototypePreviewCloseTimeout}
        onPointerLeave={(event) => {
          const movingToSecondary = eventTargetIsInsideElement(
            event.relatedTarget,
            prototypeSecondaryPanelRef.current,
          );

          if (!movingToSecondary) {
            collapsePrototypePrimary();
          }
          schedulePrototypePreviewClose();
        }}
        orientation="horizontal"
        overlays={prototypeOverlays}
        testId="sidebar-root"
        underlays={prototypeGlassUnderlay}
        width={prototypeSidebarContentWidth}
      >
        <div
          className="h-full"
          onPointerEnter={() => {
            clearPrototypePreviewCloseTimeout();
            prototypePrimaryHoverRef.current = true;
            onPrototypePrimaryHoverChange?.(true);
          }}
          onPointerLeave={(event) => {
            const movingToSecondary = eventTargetIsInsideElement(
              event.relatedTarget,
              prototypeSecondaryPanelRef.current,
            );

            if (movingToSecondary) {
              clearPrototypePreviewCloseTimeout();
              return;
            }

            collapsePrototypePrimary();
            schedulePrototypePreviewClose();
          }}
        >
          <PaneSurface
            ref={primaryNavPanelRef}
            testId="sidebar-primary-nav-panel"
            fullHeight
            glass={false}
            width={prototypePrimaryWidth}
            className={cn(
              NAV_PROTOTYPE_TRANSITION_CLASS,
              prototypeSecondaryRendered &&
                !prototypeSecondaryClosing &&
                "rounded-r-none",
            )}
          >
            <nav
              ref={navRef}
              onKeyDown={handleSidebarNavKeyDown}
              className={cn(
                "relative flex min-h-0 flex-1 flex-col overflow-hidden px-2 pt-2.5 scrollbar-none",
              )}
              aria-label={t("navigation.main")}
            >
              <div
                className={cn(
                  "min-h-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-none",
                  !prototypePrimaryCollapsed && !prototypeAnnouncementDismissed
                    ? "pb-44"
                    : "pb-20",
                )}
              >
                <div className="space-y-px">
                  <PrototypeNavRow
                    active={activeView === "home"}
                    collapsed={prototypePrimaryCollapsed}
                    icon={<SidebarNavHomeIcon />}
                    label={t("navigation.home")}
                    onClick={() => handlePrototypeNavigate("home")}
                  />
                  <PrototypeNavRow
                    active={activeView === "agents"}
                    collapsed={prototypePrimaryCollapsed}
                    icon={<SidebarNavAgentsIcon />}
                    label={t("navigation.agents")}
                    onClick={() => handlePrototypeNavigate("agents")}
                  />
                  <PrototypeNavRow
                    active={activeView === "skills"}
                    collapsed={prototypePrimaryCollapsed}
                    icon={<SidebarNavSkillsIcon />}
                    label={t("navigation.skills")}
                    onClick={() => handlePrototypeNavigate("skills")}
                  />
                  {showAutomationsSurface ? (
                    <PrototypeNavRow
                      active={activeView === "automations"}
                      collapsed={prototypePrimaryCollapsed}
                      icon={<SidebarNavAutomationsIcon />}
                      label={t("navigation.automations")}
                      onClick={() => handlePrototypeNavigate("automations")}
                    />
                  ) : null}
                  <PrototypeNavRow
                    active={
                      activeView === "session-history" ||
                      prototypeSecondaryTarget?.kind === "chats"
                    }
                    collapsed={prototypePrimaryCollapsed}
                    icon={<SidebarNavChatsIcon />}
                    label="Chats"
                    onClick={() => {
                      openPrototypeChatsSecondary();
                      onPrototypeSecondarySelect?.();
                    }}
                    trailing={
                      <>
                        <PrototypeBareActionIcon
                          label="View chat history"
                          onClick={() =>
                            handlePrototypeNavigate("session-history")
                          }
                        >
                          <History
                            className={NAV_PROTOTYPE_LUCIDE_ICON_CLASS}
                          />
                        </PrototypeBareActionIcon>
                        <PrototypeBareActionIcon
                          label={t("actions.newChat")}
                          onClick={() => {
                            commitPrototypePreview();
                            onNewChat?.();
                          }}
                        >
                          <Plus className={NAV_PROTOTYPE_LUCIDE_ICON_CLASS} />
                        </PrototypeBareActionIcon>
                      </>
                    }
                  />
                </div>

                <div className="mt-6">
                  <div className="space-y-px">
                    <div
                      className={cn(
                        "relative flex h-7 min-w-0 items-center text-sm font-normal leading-normal",
                        NAV_PROTOTYPE_SECTION_LABEL_CLASS,
                        prototypePrimaryCollapsed
                          ? "justify-center px-0"
                          : "pl-[10px] pr-8",
                      )}
                    >
                      {prototypePrimaryCollapsed ? (
                        <DefaultProjectGlyphIcon
                          aria-hidden="true"
                          className={cn("size-4", NAV_PROTOTYPE_ICON_CLASS)}
                          style={{ color: "currentColor" }}
                        />
                      ) : (
                        <>
                          <span className="min-w-0 truncate">
                            {t("sections.projects")}
                          </span>
                          <div className={NAV_PROTOTYPE_ROW_ACTION_RAIL_CLASS}>
                            <PrototypeBareActionIcon
                              className={
                                NAV_PROTOTYPE_SECTION_ACTION_ICON_CLASS
                              }
                              label={t("actions.newProject")}
                              onClick={() => {
                                collapsePrototypePrimary();
                                commitPrototypePreview();
                                onCreateProject?.();
                              }}
                            >
                              <Plus
                                className={NAV_PROTOTYPE_LUCIDE_ICON_CLASS}
                              />
                            </PrototypeBareActionIcon>
                          </div>
                        </>
                      )}
                    </div>
                    {projects.map((project) => {
                      const activeProject =
                        activePrototypeProjectId === project.id;
                      return (
                        <PrototypeProjectNavRow
                          key={project.id}
                          active={activeProject}
                          collapsed={prototypePrimaryCollapsed}
                          onArchiveProject={onArchiveProject}
                          onClick={() => {
                            openPrototypeProjectSecondary(project.id, {
                              preview: true,
                            });
                          }}
                          onEditProject={onEditProject}
                          onNewChat={async () => {
                            openPrototypeProjectSecondary(project.id);
                            commitPrototypePreview();
                            await onNewChatInProject?.(project.id, {
                              reuseExistingDraft: true,
                            });
                          }}
                          project={project}
                          prototypeNavMenuOpenRef={prototypeNavMenuOpenRef}
                        />
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-2 pb-2 pt-12">
                <div
                  aria-hidden="true"
                  className="absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-transparent to-background"
                />
                <div
                  aria-hidden="true"
                  className="absolute inset-x-0 bottom-0 top-12 bg-background"
                />
                <div className="pointer-events-auto relative">
                  {!prototypePrimaryCollapsed &&
                  !prototypeAnnouncementDismissed ? (
                    <PrototypeNavigationAnnouncement
                      onDismiss={dismissPrototypeAnnouncement}
                    />
                  ) : null}
                  <div
                    aria-hidden="true"
                    className="mx-3 mb-2 h-px bg-border/70"
                  />
                  <PrototypeNavRow
                    active={
                      activeView === "settings" ||
                      prototypeSecondaryTarget?.kind === "settings"
                    }
                    collapsed={prototypePrimaryCollapsed}
                    icon={<SidebarNavSettingsIcon />}
                    label={t("settings:title")}
                    onClick={selectPrototypeSettingsSecondary}
                  />
                </div>
              </div>
            </nav>
          </PaneSurface>
        </div>
        {prototypeSecondaryInline ? secondaryPanel : null}
      </PaneLayoutFrame>
    );
  }

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
        activeSettingsSection={activeSettingsSection}
        activeView={activeView}
        agentUpdatesAvailable={agentUpdatesAvailable}
        bottomMaskStyle={BOTTOM_MASK_STYLE}
        detachable={canDetachSessionList}
        elevatedShadow={elevatedShadow}
        fullHeight={!canDetachSessionList || visualSessionListSideDocked}
        isSecondarySurface={isSecondarySurface}
        labelTransition={labelTransition}
        mainNavRef={navRef}
        navCollapsed={navCollapsed}
        navLabelVisible={navLabelVisible}
        navPanelCompact={navPanelCompact}
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
                  onArchiveChat={
                    onArchiveChat
                      ? (sessionId) =>
                          Promise.resolve(onArchiveChat(sessionId)).then(
                            () => undefined,
                          )
                      : undefined
                  }
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
