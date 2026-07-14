import {
  type ComponentProps,
  type CSSProperties,
  type FormEvent,
  type RefObject,
  type PointerEvent as ReactPointerEvent,
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
  Link2,
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
import {
  usePinBatchToHome,
  usePinToHomeWidget,
} from "@/features/home/hooks/usePinToHomeWidget";
import { getPinnedHomeChatSessionIds } from "@/features/home/lib/pinnedHomeChats";
import { useHomeWidgetStore } from "@/features/home/stores/homeWidgetStore";
import { cn } from "@/shared/lib/cn";
import type { AppView } from "@/app/AppShell";
import type {
  ProjectChatGroupMetadata,
  ProjectChatGroupsMetadata,
  ProjectInfo,
} from "@/features/projects/api/projects";
import { PrimaryNavigationSurface } from "@/features/navigation/ui/PrimaryNavigationSurface";
import { DefaultProjectGlyphIcon } from "@/features/projects/ui/DefaultProjectGlyphIcon";
import { ProjectIcon } from "@/features/projects/ui/ProjectIcon";
import { useChatStore } from "@/features/chat/stores/chatStore";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { selectSessions } from "@/features/chat/stores/chatSessionSelectors";
import { getDisplaySessionTitle } from "@/features/chat/lib/sessionTitle";
import {
  isSessionRunning,
  sessionActivityAt,
} from "@/features/chat/lib/sessionActivity";
import type { Message } from "@/shared/types/messages";
import { INITIAL_SESSION_CHAT_RUNTIME } from "@/shared/types/chat";
import type { CommandOutcome } from "@/features/berdctl/navigation";
import { SessionListCapability } from "@/features/sessions/capabilities/SessionListCapability";
import {
  findSidebarProjectReorderTarget,
  type SidebarProjectReorderTarget,
} from "@/features/sidebar/lib/sidebarPointerDragRegistry";
import {
  clearPointerDragClickSuppression,
  hasExceededPointerDragThreshold,
  isPrimaryPointerButton,
  schedulePointerDragClickSuppressionReset,
} from "@/features/sidebar/lib/pointerDrag";
import { useBulkSessionActions } from "@/features/sessions/hooks/useBulkSessionActions";
import {
  areSetsEqual,
  normalizeSelectedSessionIds,
  toggleSessionSelection as getToggledSessionSelection,
} from "@/features/sessions/lib/sessionSelection";
import { SidebarChatRow } from "@/features/sessions/ui/session-list/SidebarChatRow";
import {
  SidebarChatDragProvider,
  useSidebarChatDrag,
} from "@/features/sessions/ui/session-list/SidebarChatDragContext";
import { SIDEBAR_DETACHED_PANEL_GAP_PX } from "@/shared/ui/sidebar-tokens";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
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
import { toast } from "sonner";

export type NavigationPrototypeMode =
  | "auto-collapse-push"
  | "manual-push"
  | "manual-float"
  | "hybrid-push-overlay";

type NavigationChatsSecondaryVariant = "more";

export type NavigationSecondaryTarget =
  | { kind: "chats"; variant?: NavigationChatsSecondaryVariant }
  | { kind: "project"; projectId: string }
  | { kind: "settings" }
  | null;

export type NavigationSelectSessionOptions = {
  suppressPrototypeSecondary?: boolean;
};

type PrototypeResizablePaneId = "primary" | "secondary";

export const NAV_PROTOTYPE_PRIMARY_EXPANDED_WIDTH_PX = 230;
export const NAV_PROTOTYPE_PRIMARY_COLLAPSED_WIDTH_PX = 48;
export const NAV_PROTOTYPE_SECONDARY_WIDTH_PX = 230;
export const NAV_PROTOTYPE_PRIMARY_MIN_WIDTH_PX = 180;
export const NAV_PROTOTYPE_PRIMARY_MAX_WIDTH_PX = 320;
export const NAV_PROTOTYPE_SECONDARY_MIN_WIDTH_PX = 200;
export const NAV_PROTOTYPE_SECONDARY_MAX_WIDTH_PX = 420;
export const NAV_PROTOTYPE_PANEL_GAP_PX = 0;
export const NAV_PROTOTYPE_PANEL_OVERLAP_PX = 1;
const NAV_PROTOTYPE_PRIMARY_CHAT_PREVIEW_FALLBACK_LIMIT = 4;
const NAV_PROTOTYPE_PROJECTS_SECTION_TOP_MARGIN_PX = 24;
const NAV_PROTOTYPE_CHAT_SECTION_TOP_MARGIN_PX = 16;
const NAV_PROTOTYPE_SECONDARY_EXIT_MS = 220;
const NAV_PROTOTYPE_ROW_HEIGHT_PX = 28;
const NAV_PROTOTYPE_ROW_GAP_PX = 1;
const NAV_PROTOTYPE_TRANSITION_CLASS =
  "transition-[width,left,transform] duration-250 ease-out";
const NAV_PROTOTYPE_PANEL_CONTENT_CLASS =
  "flex min-h-0 flex-1 flex-col overflow-hidden px-2 pb-2 pt-2.5";
const NAV_PROTOTYPE_SECTION_LABEL_CLASS =
  "text-[var(--sidebar-prototype-nav-muted-fg)]";
const NAV_PROTOTYPE_EXPANDED_ROW_START_CLASS = "pl-2";
const NAV_PROTOTYPE_COLLAPSED_ROW_CLASS = "justify-start gap-2 pl-2 pr-3";
const NAV_PROTOTYPE_TEXT_MUTED_CLASS =
  "text-[var(--sidebar-prototype-nav-muted-fg)]";
const NAV_PROTOTYPE_TEXT_DEFAULT_CLASS =
  "text-[var(--sidebar-prototype-nav-default-fg)]";
const NAV_PROTOTYPE_TEXT_ACTIVE_CLASS =
  "text-[var(--sidebar-prototype-nav-active-fg)]";
const NAV_PROTOTYPE_ROW_ACTIVE_CLASS = `sidebar-prototype-nav-row-active ${NAV_PROTOTYPE_TEXT_ACTIVE_CLASS}`;
const NAV_PROTOTYPE_ROW_HOVER_CLASS =
  "sidebar-prototype-nav-row-hover hover:text-[var(--sidebar-prototype-nav-active-fg)] focus-visible:text-[var(--sidebar-prototype-nav-active-fg)]";
const NAV_PROTOTYPE_GROUP_ROW_HOVER_CLASS =
  "sidebar-prototype-nav-group-row-hover group-hover/prototype-project-group:text-[var(--sidebar-prototype-nav-active-fg)] focus-visible:text-[var(--sidebar-prototype-nav-active-fg)]";
const NAV_PROTOTYPE_ICON_CLASS = "text-current";
const NAV_PROTOTYPE_ACTION_ICON_CLASS =
  "text-[var(--sidebar-prototype-nav-default-fg)] opacity-80 hover:opacity-100 focus-visible:opacity-100";
const NAV_PROTOTYPE_SECTION_ACTION_ICON_CLASS =
  "rounded-sm text-[var(--sidebar-prototype-nav-muted-fg)] opacity-80 hover:opacity-100 focus-visible:opacity-100";
const NAV_PROTOTYPE_GROUP_ACTION_ICON_CLASS =
  "text-[var(--sidebar-prototype-nav-muted-fg)] opacity-80 hover:opacity-100 focus-visible:opacity-100";
const NAV_PROTOTYPE_ICON_SLOT_CLASS =
  "flex size-4 shrink-0 items-center justify-center";
const NAV_PROTOTYPE_LUCIDE_ICON_CLASS = "size-3.5";
const NAV_PROTOTYPE_MENU_CONTENT_CLASS =
  "px-1 py-1 text-[14px] leading-[18px] [&_[data-slot=context-menu-item]]:text-[14px] [&_[data-slot=context-menu-item]]:leading-[18px] [&_[data-slot=dropdown-menu-item]]:text-[14px] [&_[data-slot=dropdown-menu-item]]:leading-[18px]";
const NAV_PROTOTYPE_CHAT_ROW_MENU_CONTENT_CLASS = cn(
  "w-56 rounded-[10px]",
  NAV_PROTOTYPE_MENU_CONTENT_CLASS,
);
const NAV_PROTOTYPE_MENU_ITEM_CLASS =
  "gap-2 whitespace-nowrap rounded-[6px] px-2 py-1.5 text-[14px] leading-[18px] opacity-[0.85] hover:!bg-transparent hover:opacity-100 focus:!bg-transparent focus:!text-popover-inverse-foreground focus:opacity-100 data-[highlighted]:!bg-transparent data-[highlighted]:!text-popover-inverse-foreground data-[highlighted]:opacity-100";
const NAV_PROTOTYPE_MENU_LABEL_CLASS = "px-2 py-1 text-[14px] leading-[18px]";
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
  if (a.kind === "chats" || b.kind === "chats") {
    return a.kind === "chats" && b.kind === "chats"
      ? (a.variant ?? null) === (b.variant ?? null)
      : false;
  }
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
  onReorderProject?: (
    fromId: string,
    toId: string,
    placement?: "before" | "after",
  ) => void;
  onNavigate?: (view: AppView) => void;
  onSelectSession?: (
    sessionId: string,
    options?: NavigationSelectSessionOptions,
  ) => void;
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
  onPrototypePrimaryWidthResize?: (width: number) => void;
  onPrototypeSecondaryWidthResize?: (width: number) => void;
  prototypeSecondaryFloating?: boolean;
  prototypePrimaryOverlaysContent?: boolean;
  prototypeSecondaryPush?: boolean;
  prototypeChatsUnderProjects?: boolean;
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
  "connections",
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

function comparePrototypeSessions(
  pinnedSessionIds: ReadonlySet<string>,
  a: ChatSession,
  b: ChatSession,
) {
  const aPinned = pinnedSessionIds.has(a.id);
  const bPinned = pinnedSessionIds.has(b.id);
  if (aPinned !== bPinned) {
    return aPinned ? -1 : 1;
  }

  return compareSessionsByUpdatedAtDesc(a, b);
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

function getVisiblePrototypeChatSessions(
  sessions: ChatSession[],
  pinnedSessionIds: ReadonlySet<string>,
) {
  return sessions
    .filter((session) => !session.archivedAt)
    .sort((a, b) => comparePrototypeSessions(pinnedSessionIds, a, b));
}

function getLoosePrototypeChatSessions(sessions: ChatSession[]) {
  return sessions.filter((session) => !session.projectId);
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

type PrototypeChatRowBehaviorProps = {
  isPinningSelectedToHome: boolean;
  onArchiveChat?: (
    sessionId: string,
  ) => ArchiveChatResult | Promise<ArchiveChatResult>;
  onArchiveSelected?: () => void;
  onForkChat?: (sessionId: string) => void;
  onMarkChatRead?: (sessionId: string) => void;
  onMarkChatUnread?: (sessionId: string) => void;
  onMarkSelectedRead?: () => void;
  onMarkSelectedUnread?: () => void;
  onRenameChat?: (sessionId: string, nextTitle: string) => void;
  onSelectionChange: (sessionId: string, selected: boolean) => void;
  onSelectionClear: () => void;
  onPinSelectedToHome: () => void;
  pinnedHomeChatSessionIds: ReadonlySet<string>;
  selectedSessionIds: Set<string>;
  selectionActionsDisabled: boolean;
  selectionEnabled: boolean;
};

type PrototypeProjectPointerDragState = {
  dragging: boolean;
  pointerId: number;
  projectId: string;
  startX: number;
  startY: number;
};

type PrototypeProjectDropTargetState = {
  placement: "before" | "after";
  projectId: string;
};

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
  containerRef,
  dropIndicator,
  icon,
  label,
  onClick,
  onFocus,
  onMouseEnter,
  trailing,
}: {
  active?: boolean;
  collapsed: boolean;
  containerRef?: RefObject<HTMLDivElement | null>;
  dropIndicator?: ReactNode;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  onFocus?: () => void;
  onMouseEnter?: () => void;
  trailing?: ReactNode;
}) {
  return (
    <div
      ref={containerRef}
      className="group/prototype-row relative flex items-center"
    >
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
            ? NAV_PROTOTYPE_COLLAPSED_ROW_CLASS
            : cn(
                "justify-start gap-2",
                NAV_PROTOTYPE_EXPANDED_ROW_START_CLASS,
                trailing ? "pr-8" : "pr-3",
              ),
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
            "max-w-[180px] translate-x-0",
            collapsed ? "pointer-events-none opacity-0" : "opacity-100",
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
      {dropIndicator}
    </div>
  );
}

function PrototypePrimarySectionHeader({
  actions,
  collapsed,
  icon,
  label,
  testId,
}: {
  actions?: ReactNode;
  collapsed: boolean;
  icon: ReactNode;
  label: ReactNode;
  testId: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "group/prototype-section-header relative flex h-7 min-w-0 items-center text-sm font-normal leading-normal",
        collapsed
          ? NAV_PROTOTYPE_COLLAPSED_ROW_CLASS
          : cn(NAV_PROTOTYPE_EXPANDED_ROW_START_CLASS, "pr-8"),
        NAV_PROTOTYPE_SECTION_LABEL_CLASS,
      )}
    >
      <span
        aria-hidden="true"
        data-testid={`${testId}-icon`}
        className={cn(
          "absolute flex size-4 items-center justify-center transition-opacity duration-250 ease-out",
          NAV_PROTOTYPE_ICON_CLASS,
          "left-2",
          collapsed ? "translate-x-0 opacity-100" : "translate-x-0 opacity-0",
        )}
      >
        {icon}
      </span>
      <span
        data-testid={`${testId}-label`}
        className={cn(
          "min-w-0 truncate transition-opacity duration-250 ease-out",
          "translate-x-0",
          collapsed ? "pointer-events-none opacity-0" : "opacity-100",
        )}
      >
        {label}
      </span>
      {actions ? (
        <div
          className={cn(
            NAV_PROTOTYPE_ROW_ACTION_RAIL_CLASS,
            "gap-0.5 transition-opacity duration-150",
            collapsed
              ? "pointer-events-none opacity-0"
              : "opacity-0 group-hover/prototype-section-header:opacity-100 group-focus-within/prototype-section-header:opacity-100",
          )}
        >
          {actions}
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
  onMoveToProject,
  onNewChat,
  project,
  prototypeNavMenuOpenRef,
}: {
  active: boolean;
  collapsed: boolean;
  onArchiveProject?: (projectId: string) => void;
  onClick: () => void;
  onEditProject?: (projectId: string) => void;
  onMoveToProject?: (sessionId: string, projectId: string | null) => void;
  onNewChat?: PrototypeActionHandler;
  project: ProjectInfo;
  prototypeNavMenuOpenRef: { current: boolean };
}) {
  const { t } = useTranslation(["sidebar", "common"]);
  const dropTargetRef = useRef<HTMLDivElement>(null);
  const dropTargetKey = `prototype-project:${project.id}`;
  const { activeSessionDropTargetKey, registerSessionDropTarget } =
    useSidebarChatDrag();
  const { isPinned, isPinning, pinToHome, unpinFromHome } = usePinToHomeWidget({
    kind: "project",
    id: project.id,
  });
  const handleSessionDrop = useCallback(
    (sessionId: string) => {
      onMoveToProject?.(sessionId, project.id);
    },
    [onMoveToProject, project.id],
  );

  useEffect(() => {
    const element = dropTargetRef.current;
    if (!element || !onMoveToProject) return;

    return registerSessionDropTarget({
      key: dropTargetKey,
      kind: "project",
      projectId: project.id,
      element,
      onDrop: handleSessionDrop,
    });
  }, [
    dropTargetKey,
    handleSessionDrop,
    onMoveToProject,
    project.id,
    registerSessionDropTarget,
  ]);

  const pinLabel = isPinned
    ? t("common:actions.unpinFromHome")
    : isPinning
      ? t("common:actions.pinningToHome")
      : t("common:actions.pinToHome");

  return (
    <PrototypeNavRow
      active={active}
      collapsed={collapsed}
      containerRef={dropTargetRef}
      dropIndicator={
        activeSessionDropTargetKey === dropTargetKey ? (
          <div className="absolute bottom-0 left-3 right-3 h-px bg-sidebar-foreground" />
        ) : null
      }
      icon={
        <ProjectIcon
          icon={project.icon}
          color={project.color}
          projectId={project.id}
          className="size-4 shrink-0"
          imageClassName="size-4 shrink-0 rounded-[3px]"
        />
      }
      label={project.name}
      onClick={onClick}
      trailing={
        <>
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
          <PrototypeBareActionIcon
            label={`New chat in ${project.name}`}
            onClick={onNewChat ?? (() => {})}
          >
            <SquarePen className={NAV_PROTOTYPE_LUCIDE_ICON_CLASS} />
          </PrototypeBareActionIcon>
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
  closeOnSelect = true,
  onSelect,
}: {
  active: boolean;
  children: ReactNode;
  closeOnSelect?: boolean;
  onSelect: () => void;
}) {
  return (
    <PrototypeNavMenuItem
      className={cn(
        "w-full justify-between text-popover-inverse-foreground focus:!bg-transparent focus:!text-popover-inverse-foreground data-[highlighted]:!bg-transparent data-[highlighted]:!text-popover-inverse-foreground",
      )}
      onSelect={(event) => {
        if (!closeOnSelect) {
          event.preventDefault();
        }
        onSelect();
      }}
    >
      <span className="min-w-0 flex-1">{children}</span>
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {active ? <Check className={NAV_PROTOTYPE_LUCIDE_ICON_CLASS} /> : null}
      </span>
    </PrototypeNavMenuItem>
  );
}

function PrototypeChatFilterMenuLabel({ children }: { children: ReactNode }) {
  return (
    <div
      className={cn(
        NAV_PROTOTYPE_MENU_LABEL_CLASS,
        "font-normal",
        NAV_PROTOTYPE_SECTION_LABEL_CLASS,
      )}
    >
      {children}
    </div>
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

function PrototypePrimaryChatRow({
  active,
  collapsed,
  icon,
  label,
  muted = false,
  onClick,
  showIcon = true,
  sessionId,
}: {
  active?: boolean;
  collapsed: boolean;
  icon?: ReactNode;
  label: string;
  muted?: boolean;
  onClick: () => void;
  showIcon?: boolean;
  sessionId?: string;
}) {
  const hasVisibleRowContent = !collapsed || showIcon;

  return (
    <button
      type="button"
      data-session-id={sessionId}
      onClick={onClick}
      title={collapsed ? label : undefined}
      aria-label={label}
      className={cn(
        "flex h-7 w-full items-center rounded-sm text-left text-sm font-normal leading-normal transition-colors duration-150",
        collapsed
          ? NAV_PROTOTYPE_COLLAPSED_ROW_CLASS
          : cn("gap-2 pr-3", NAV_PROTOTYPE_EXPANDED_ROW_START_CLASS),
        muted
          ? cn(
              NAV_PROTOTYPE_SECTION_LABEL_CLASS,
              hasVisibleRowContent && NAV_PROTOTYPE_ROW_HOVER_CLASS,
            )
          : active && hasVisibleRowContent
            ? NAV_PROTOTYPE_ROW_ACTIVE_CLASS
            : cn(
                NAV_PROTOTYPE_TEXT_DEFAULT_CLASS,
                hasVisibleRowContent && NAV_PROTOTYPE_ROW_HOVER_CLASS,
              ),
      )}
    >
      {showIcon ? (
        <span
          data-testid="prototype-primary-chat-row-icon"
          className={cn(
            NAV_PROTOTYPE_ICON_SLOT_CLASS,
            NAV_PROTOTYPE_ICON_CLASS,
          )}
        >
          {icon ?? <SidebarNavChatsIcon className="size-4 shrink-0" />}
        </span>
      ) : null}
      <span
        className={cn(
          "min-w-0 flex-1 overflow-hidden whitespace-nowrap transition-[max-width,opacity,transform] duration-150 ease-out",
          "max-w-[180px] translate-x-0",
          collapsed ? "pointer-events-none opacity-0" : "opacity-100",
        )}
      >
        <span className="block truncate">{label}</span>
      </span>
    </button>
  );
}

function PrototypeRecentsDropTarget({
  enabled = true,
  indicatorClassName = "absolute bottom-0 left-3 right-3 h-px bg-sidebar-foreground",
  onMoveToProject,
  targetKey,
}: {
  enabled?: boolean;
  indicatorClassName?: string;
  onMoveToProject?: (sessionId: string, projectId: string | null) => void;
  targetKey: string;
}) {
  const dropTargetRef = useRef<HTMLDivElement>(null);
  const { activeSessionDropTargetKey, registerSessionDropTarget } =
    useSidebarChatDrag();
  const handleSessionDrop = useCallback(
    (sessionId: string) => {
      onMoveToProject?.(sessionId, null);
    },
    [onMoveToProject],
  );

  useEffect(() => {
    const element = dropTargetRef.current;
    if (!enabled || !element || !onMoveToProject) return;

    return registerSessionDropTarget({
      key: targetKey,
      kind: "recents",
      projectId: null,
      element,
      onDrop: handleSessionDrop,
    });
  }, [
    enabled,
    handleSessionDrop,
    onMoveToProject,
    registerSessionDropTarget,
    targetKey,
  ]);

  return (
    <>
      <div
        ref={dropTargetRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        data-sidebar-session-drop-target="recents"
      />
      {activeSessionDropTargetKey === targetKey ? (
        <div className={indicatorClassName} />
      ) : null}
    </>
  );
}

function PrototypeSidebarChatRow({
  active,
  behavior,
  className,
  contentPaddingClassName,
  currentProjectId = null,
  density = "dense",
  leadingIcon,
  leadingIconTestId,
  nested = false,
  onEditProject,
  onMenuOpenChange,
  onSelect,
  project,
  renderExtraMenuItems,
  session,
  showIcon = true,
  showTimestamp = true,
}: {
  active: boolean;
  behavior: PrototypeChatRowBehaviorProps;
  className?: string;
  contentPaddingClassName?: string;
  currentProjectId?: string | null;
  density?: ComponentProps<typeof SidebarChatRow>["density"];
  leadingIcon?: ReactNode;
  leadingIconTestId?: string;
  nested?: boolean;
  onEditProject?: (projectId: string) => void;
  onMenuOpenChange?: (open: boolean) => void;
  onSelect?: (sessionId: string) => void;
  project?: ProjectInfo | null;
  renderExtraMenuItems?: ComponentProps<
    typeof SidebarChatRow
  >["renderExtraMenuItems"];
  session: ChatSession;
  showIcon?: boolean;
  showTimestamp?: boolean;
}) {
  const runtime = useChatStore(
    (state) =>
      state.sessionStateById[session.id] ?? INITIAL_SESSION_CHAT_RUNTIME,
  );

  return (
    <SidebarChatRow
      id={session.id}
      title={session.title}
      activityAt={showTimestamp ? sessionActivityAt(session) : null}
      isActive={active}
      isRunning={isSessionRunning(runtime.chatState)}
      hasUnread={runtime.hasUnread}
      selected={behavior.selectedSessionIds.has(session.id)}
      selectionEnabled={behavior.selectionEnabled}
      selectionActionsDisabled={behavior.selectionActionsDisabled}
      selectedSessionIds={behavior.selectedSessionIds}
      className={className}
      contentPaddingClassName={contentPaddingClassName}
      nested={nested}
      density={density}
      leadingIcon={
        leadingIcon ??
        (project ? (
          <ProjectIcon
            icon={project.icon}
            color={project.color}
            projectId={project.id}
            className="size-[18px]"
            imageClassName="size-[18px] rounded-[4px]"
          />
        ) : undefined)
      }
      showLeadingIcon={showIcon}
      leadingIconTestId={leadingIconTestId}
      flatProjectName={showIcon && project ? project.name : undefined}
      flatProjectIcon={showIcon && project ? project.icon : undefined}
      flatProjectColor={showIcon && project ? project.color : undefined}
      currentProjectId={currentProjectId}
      onEditProject={onEditProject}
      onSelect={onSelect}
      onSelectionClear={behavior.onSelectionClear}
      onSelectionChange={behavior.onSelectionChange}
      onRename={behavior.onRenameChat}
      onFork={behavior.onForkChat}
      onArchive={
        behavior.onArchiveChat
          ? (sessionId) =>
              Promise.resolve(behavior.onArchiveChat?.(sessionId)).then(
                () => undefined,
              )
          : undefined
      }
      onArchiveSelected={behavior.onArchiveSelected}
      onPinSelectedToHome={behavior.onPinSelectedToHome}
      isPinningSelectedToHome={behavior.isPinningSelectedToHome}
      onMenuOpenChange={onMenuOpenChange}
      onMarkRead={behavior.onMarkChatRead}
      onMarkUnread={behavior.onMarkChatUnread}
      onMarkSelectedRead={behavior.onMarkSelectedRead}
      onMarkSelectedUnread={behavior.onMarkSelectedUnread}
      menuContentClassName={NAV_PROTOTYPE_CHAT_ROW_MENU_CONTENT_CLASS}
      menuItemClassName={NAV_PROTOTYPE_MENU_ITEM_CLASS}
      menuItemStyle={NAV_PROTOTYPE_MENU_ITEM_STYLE}
      menuLabelClassName={NAV_PROTOTYPE_MENU_LABEL_CLASS}
      menuLabelStyle={NAV_PROTOTYPE_MENU_ITEM_STYLE}
      renderExtraMenuItems={renderExtraMenuItems}
    />
  );
}

function PrototypeProjectChatRow({
  active,
  behavior,
  chat,
  currentProjectId,
  nested = false,
  onCreateGroup,
  onDelete,
  onMenuOpenChange,
  onPrototypeSelect,
  onSelect,
  showPlaceholderIcon = false,
  showTimestamp = true,
}: {
  active: boolean;
  behavior: PrototypeChatRowBehaviorProps;
  chat: PrototypeProjectChatItem;
  currentProjectId: string | null;
  nested?: boolean;
  onCreateGroup?: (chat: PrototypeProjectChatItem) => void;
  onDelete?: (chat: PrototypeProjectChatItem) => void;
  onMenuOpenChange?: (open: boolean) => void;
  onPrototypeSelect?: (chat: PrototypeProjectChatItem) => void;
  onSelect?: (sessionId: string) => void;
  showPlaceholderIcon?: boolean;
  showTimestamp?: boolean;
}) {
  const { t } = useTranslation("common");
  const defaultSessionTitle = t("session.defaultTitle");
  const title = chat.session
    ? getDisplaySessionTitle(chat.session.title, defaultSessionTitle)
    : chat.title;
  const isUnsavedDefaultChat =
    title === defaultSessionTitle && (chat.session?.messageCount ?? 0) === 0;
  const showRealDraftNewChatIcon = isUnsavedDefaultChat && !nested;
  const showNewChatIcon = showPlaceholderIcon;
  const showActions = !chat.placeholder && !isUnsavedDefaultChat;

  const selectChat = () => {
    if (chat.session) {
      onSelect?.(chat.session.id);
    } else {
      onPrototypeSelect?.(chat);
    }
  };

  if (chat.session && !chat.placeholder) {
    return (
      <PrototypeSidebarChatRow
        active={active}
        behavior={behavior}
        currentProjectId={currentProjectId}
        leadingIcon={
          showRealDraftNewChatIcon ? (
            <Plus className={NAV_PROTOTYPE_LUCIDE_ICON_CLASS} />
          ) : undefined
        }
        leadingIconTestId={
          showRealDraftNewChatIcon
            ? "prototype-project-new-chat-icon"
            : undefined
        }
        nested={nested}
        onMenuOpenChange={onMenuOpenChange}
        onSelect={onSelect}
        session={chat.session}
        showTimestamp={showTimestamp}
        renderExtraMenuItems={
          showActions
            ? ({ Item, Separator, itemClassName, itemStyle }) => (
                <>
                  <Separator className="mx-2 opacity-40" />
                  <Item
                    className={itemClassName}
                    onClick={() => onCreateGroup?.(chat)}
                    style={itemStyle}
                  >
                    <GitBranchPlus
                      className={NAV_PROTOTYPE_LUCIDE_ICON_CLASS}
                    />
                    Create group
                  </Item>
                  <Item
                    className={itemClassName}
                    onClick={() => onDelete?.(chat)}
                    style={itemStyle}
                  >
                    <Trash2 className={NAV_PROTOTYPE_LUCIDE_ICON_CLASS} />
                    Delete
                  </Item>
                </>
              )
            : undefined
        }
      />
    );
  }

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
  chatRowBehavior,
  onCreateProject,
  onEditProject,
  onArchiveChat,
  onCommitPreview,
  onNavigationMenuOpenChange,
  onNavigate,
  onMoveToProject,
  onNewChatInProject,
  onOpenSettingsSection,
  onSecondarySelect,
  onSelectSession,
  onShowChatIconsChange,
  onShowChatTimestampsChange,
  onUpdateProjectChatGroups,
  prototypeChatsUnderProjects,
  projects,
  search,
  secondaryTarget,
  omittedChatSessionIds,
  sessions,
  settingsSections,
  setSearch,
  showChatIcons,
  showChatTimestamps,
  resizeRail,
  width,
}: {
  activeSessionId?: string | null;
  activeSettingsSection: SectionId;
  chatRowBehavior: PrototypeChatRowBehaviorProps;
  onCreateProject?: () => void;
  onEditProject?: (projectId: string) => void;
  onArchiveChat?: (
    sessionId: string,
  ) => ArchiveChatResult | Promise<ArchiveChatResult>;
  onCommitPreview?: () => void;
  onNavigationMenuOpenChange?: (open: boolean) => void;
  onNavigate?: (view: AppView) => void;
  onMoveToProject?: (sessionId: string, projectId: string | null) => void;
  onNewChatInProject?: (
    projectId: string,
    options?: PrototypeProjectNewChatOptions,
  ) => ChatSession | Promise<ChatSession | undefined> | undefined;
  onOpenSettingsSection?: (section: SectionId) => void;
  onSecondarySelect?: () => void;
  onSelectSession?: (
    sessionId: string,
    options?: NavigationSelectSessionOptions,
  ) => void;
  onShowChatIconsChange: (showChatIcons: boolean) => void;
  onShowChatTimestampsChange: (showChatTimestamps: boolean) => void;
  onUpdateProjectChatGroups?: (
    projectId: string,
    chatGroups: ProjectChatGroupsMetadata | null,
  ) => void | Promise<void>;
  prototypeChatsUnderProjects: boolean;
  projects: ProjectInfo[];
  search: string;
  secondaryTarget: NavigationSecondaryTarget;
  omittedChatSessionIds?: readonly string[];
  sessions: ChatSession[];
  settingsSections: ReturnType<typeof getVisibleSettingsSections>;
  setSearch: (value: string) => void;
  showChatIcons: boolean;
  showChatTimestamps: boolean;
  resizeRail?: ReactNode;
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
  const projectsById = useMemo(
    () => new Map(projects.map((candidate) => [candidate.id, candidate])),
    [projects],
  );
  const visibleSessions = getVisiblePrototypeChatSessions(
    sessions,
    chatRowBehavior.pinnedHomeChatSessionIds,
  );
  const chatVisibleSessions = prototypeChatsUnderProjects
    ? getLoosePrototypeChatSessions(visibleSessions)
    : visibleSessions;
  const chatArchivedSessions = (
    prototypeChatsUnderProjects
      ? getLoosePrototypeChatSessions(sessions)
      : sessions
  )
    .filter((session) => session.archivedAt)
    .sort(compareSessionsByArchivedAtDesc);
  const omittedChatSessionIdSet = useMemo(
    () => new Set(omittedChatSessionIds ?? []),
    [omittedChatSessionIds],
  );

  const chatBaseSessions =
    chatViewMode === "archived" ? chatArchivedSessions : chatVisibleSessions;
  const chatSessions = chatBaseSessions
    .filter((session) => !omittedChatSessionIdSet.has(session.id))
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
        {resizeRail}
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
                    "w-40 rounded-[10px] pb-2",
                    NAV_PROTOTYPE_MENU_CONTENT_CLASS,
                  )}
                >
                  <PrototypeChatFilterMenuLabel>
                    Sort by
                  </PrototypeChatFilterMenuLabel>
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
                  <div
                    aria-hidden="true"
                    className="mx-1 my-1 h-px bg-white/10"
                  />
                  <PrototypeChatFilterMenuLabel>
                    View
                  </PrototypeChatFilterMenuLabel>
                  <PrototypeChatFilterMenuItem
                    active={showChatIcons}
                    closeOnSelect={false}
                    onSelect={() => onShowChatIconsChange(!showChatIcons)}
                  >
                    Chat icons
                  </PrototypeChatFilterMenuItem>
                  <PrototypeChatFilterMenuItem
                    active={showChatTimestamps}
                    closeOnSelect={false}
                    onSelect={() =>
                      onShowChatTimestampsChange(!showChatTimestamps)
                    }
                  >
                    Timestamps
                  </PrototypeChatFilterMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </label>
            <div className="relative min-h-0 flex-1">
              <PrototypeRecentsDropTarget
                enabled={secondaryTarget?.kind === "chats"}
                indicatorClassName="absolute left-3 right-3 top-0 z-10 h-px bg-sidebar-foreground"
                onMoveToProject={onMoveToProject}
                targetKey="prototype-secondary-recents"
              />
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
                          <PrototypeSidebarChatRow
                            key={session.id}
                            active={activeSessionId === session.id}
                            behavior={chatRowBehavior}
                            currentProjectId={session.projectId ?? null}
                            leadingIconTestId="prototype-session-row-icon"
                            onEditProject={onEditProject}
                            onMenuOpenChange={onNavigationMenuOpenChange}
                            project={
                              session.projectId
                                ? (projectsById.get(session.projectId) ?? null)
                                : null
                            }
                            session={session}
                            showIcon={showChatIcons}
                            showTimestamp={showChatTimestamps}
                            onSelect={selectRealSession}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-px">
                    {chatSessions.map((session) => (
                      <PrototypeSidebarChatRow
                        key={session.id}
                        active={activeSessionId === session.id}
                        behavior={chatRowBehavior}
                        currentProjectId={session.projectId ?? null}
                        leadingIconTestId="prototype-session-row-icon"
                        onEditProject={onEditProject}
                        onMenuOpenChange={onNavigationMenuOpenChange}
                        project={
                          session.projectId
                            ? (projectsById.get(session.projectId) ?? null)
                            : null
                        }
                        session={session}
                        showIcon={showChatIcons}
                        showTimestamp={showChatTimestamps}
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
                                  behavior={chatRowBehavior}
                                  chat={chat}
                                  currentProjectId={project.id}
                                  nested
                                  onCreateGroup={openCreateGroupDialog}
                                  onDelete={deleteProjectChat}
                                  onMenuOpenChange={(open) => {
                                    onNavigationMenuOpenChange?.(open);
                                  }}
                                  onPrototypeSelect={(prototypeChat) =>
                                    selectPrototypeChat(
                                      prototypeChat,
                                      group.name,
                                    )
                                  }
                                  onSelect={selectRealSession}
                                  showTimestamp={showChatTimestamps}
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
                          behavior={chatRowBehavior}
                          chat={chat}
                          currentProjectId={project.id}
                          onCreateGroup={openCreateGroupDialog}
                          onDelete={deleteProjectChat}
                          onMenuOpenChange={(open) => {
                            onNavigationMenuOpenChange?.(open);
                          }}
                          onPrototypeSelect={(prototypeChat) =>
                            selectPrototypeChat(prototypeChat, "Ungrouped")
                          }
                          onSelect={selectRealSession}
                          showTimestamp={showChatTimestamps}
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
  onPrototypePrimaryWidthResize,
  onPrototypeSecondaryWidthResize,
  prototypePrimaryOverlaysContent = false,
  prototypeSecondaryPush = false,
  prototypeChatsUnderProjects = false,
  className,
  projects,
}: NavigationPanesViewProps) {
  const { t } = useTranslation(["sidebar", "common", "settings"]);
  const agentUpdatesAvailable = useAgentUpdatesAvailable();
  const navRef = useRef<HTMLElement>(null);
  const primaryNavPanelRef = useRef<HTMLDivElement>(null);
  const prototypePrimaryScrollRef = useRef<HTMLDivElement>(null);
  const prototypePrimaryNavGroupRef = useRef<HTMLDivElement>(null);
  const prototypePrimaryProjectsGroupRef = useRef<HTMLDivElement>(null);
  const prototypePrimaryChatsGroupRef = useRef<HTMLDivElement>(null);
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
  const [showPrototypeChatIcons, setShowPrototypeChatIcons] = useState(true);
  const [showPrototypeChatTimestamps, setShowPrototypeChatTimestamps] =
    useState(true);
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
  const [
    prototypePrimaryChatPreviewLimit,
    setPrototypePrimaryChatPreviewLimit,
  ] = useState(NAV_PROTOTYPE_PRIMARY_CHAT_PREVIEW_FALLBACK_LIMIT);
  const prototypePreviewCloseTimeoutRef = useRef<number | null>(null);
  const prototypePrimaryHoverRef = useRef(false);
  const prototypeSecondaryHoverRef = useRef(false);
  const prototypeResizeActiveRef = useRef(false);
  const prototypeNavMenuOpenRef = useRef(false);
  const prototypeSecondaryInteractedRef = useRef(false);
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
  const homeWidgetInstances = useHomeWidgetStore((state) => state.instances);
  const pinnedHomeChatSessionIds = useMemo(
    () => getPinnedHomeChatSessionIds(homeWidgetInstances),
    [homeWidgetInstances],
  );
  const visiblePrototypeChatSessions = useMemo(
    () => getVisiblePrototypeChatSessions(sessions, pinnedHomeChatSessionIds),
    [sessions, pinnedHomeChatSessionIds],
  );
  const looseVisiblePrototypeChatSessions = useMemo(
    () => getLoosePrototypeChatSessions(visiblePrototypeChatSessions),
    [visiblePrototypeChatSessions],
  );
  const prototypePrimaryChatSessions = useMemo(
    () =>
      looseVisiblePrototypeChatSessions.slice(
        0,
        prototypePrimaryChatPreviewLimit,
      ),
    [looseVisiblePrototypeChatSessions, prototypePrimaryChatPreviewLimit],
  );
  const activePrototypeSessionIds = useMemo(
    () => new Set(visiblePrototypeChatSessions.map((session) => session.id)),
    [visiblePrototypeChatSessions],
  );
  const [selectedPrototypeSessionIds, setSelectedPrototypeSessionIds] =
    useState<Set<string>>(() => new Set());
  const selectedPrototypeSessionCount = selectedPrototypeSessionIds.size;
  const clearPrototypeSelection = useCallback(() => {
    setSelectedPrototypeSessionIds(new Set());
  }, []);
  const reportPrototypeBulkFailure = useCallback(
    (failedCount: number) => {
      toast.error(
        t("common:bulkActions.failed", {
          count: failedCount,
          displayCount: failedCount,
        }),
      );
    },
    [t],
  );
  const {
    applySelectionAction: applyPrototypeSelectionAction,
    archiveConfirmOpen: prototypeArchiveConfirmOpen,
    archiveSelectionCount: prototypeArchiveSelectionCount,
    confirmArchiveSelected: confirmPrototypeArchiveSelected,
    isApplyingSelectionAction: isApplyingPrototypeSelectionAction,
    requestArchiveSelected: requestPrototypeArchiveSelected,
    setArchiveConfirmOpen: setPrototypeArchiveConfirmOpen,
  } = useBulkSessionActions({
    selectedSessionIds: selectedPrototypeSessionIds,
    onComplete: clearPrototypeSelection,
    onFailure: reportPrototypeBulkFailure,
  });
  const { pinBatchToHome, isPinningBatch } = usePinBatchToHome();
  const pinSelectedPrototypeChatsToHome = useCallback(() => {
    void pinBatchToHome("chat", Array.from(selectedPrototypeSessionIds)).then(
      clearPrototypeSelection,
    );
  }, [clearPrototypeSelection, pinBatchToHome, selectedPrototypeSessionIds]);
  const togglePrototypeSessionSelection = useCallback(
    (sessionId: string, selected: boolean) => {
      setSelectedPrototypeSessionIds((current) =>
        getToggledSessionSelection({
          current,
          sessionId,
          selected,
          activeSessionId,
          activeSessionIds: activePrototypeSessionIds,
          includeActiveSessionOnStart: true,
          clearActiveOnlySelection: true,
        }),
      );
    },
    [activePrototypeSessionIds, activeSessionId],
  );
  const prototypeChatRowBehavior = useMemo<PrototypeChatRowBehaviorProps>(
    () => ({
      isPinningSelectedToHome: isPinningBatch,
      onArchiveChat,
      onArchiveSelected: requestPrototypeArchiveSelected,
      onForkChat,
      onMarkChatRead,
      onMarkChatUnread,
      onMarkSelectedRead: () =>
        void applyPrototypeSelectionAction(onMarkChatRead),
      onMarkSelectedUnread: () =>
        void applyPrototypeSelectionAction(onMarkChatUnread),
      onPinSelectedToHome: pinSelectedPrototypeChatsToHome,
      onRenameChat,
      onSelectionChange: togglePrototypeSessionSelection,
      onSelectionClear: clearPrototypeSelection,
      pinnedHomeChatSessionIds,
      selectedSessionIds: selectedPrototypeSessionIds,
      selectionActionsDisabled: isApplyingPrototypeSelectionAction,
      selectionEnabled: selectedPrototypeSessionCount > 0,
    }),
    [
      applyPrototypeSelectionAction,
      clearPrototypeSelection,
      isApplyingPrototypeSelectionAction,
      isPinningBatch,
      onArchiveChat,
      onForkChat,
      onMarkChatRead,
      onMarkChatUnread,
      onRenameChat,
      pinSelectedPrototypeChatsToHome,
      pinnedHomeChatSessionIds,
      requestPrototypeArchiveSelected,
      selectedPrototypeSessionCount,
      selectedPrototypeSessionIds,
      togglePrototypeSessionSelection,
    ],
  );
  const handleSessionSelectForScroll = useCallback((sessionId: string) => {
    skipActiveSessionScrollRef.current = sessionId;
  }, []);

  const isPrototype = Boolean(prototypeMode);
  useEffect(() => {
    setSelectedPrototypeSessionIds((current) => {
      const next = normalizeSelectedSessionIds({
        current,
        activeSessionIds: activePrototypeSessionIds,
        activeSessionId,
        includeActiveSession: true,
      });

      return areSetsEqual(next, current) ? current : next;
    });
  }, [activePrototypeSessionIds, activeSessionId]);

  useEffect(() => {
    if (selectedPrototypeSessionCount === 0) return;

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target) return;
      if (target.closest("[data-sidebar-chat-row]")) return;
      if (
        target.closest('[role="menu"]') ||
        target.closest('[role="dialog"]') ||
        target.closest('[role="alertdialog"]')
      ) {
        return;
      }

      clearPrototypeSelection();
    };

    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [clearPrototypeSelection, selectedPrototypeSessionCount]);

  const [draggedPrototypeProjectId, setDraggedPrototypeProjectId] = useState<
    string | null
  >(null);
  const [prototypeProjectDropTarget, setPrototypeProjectDropTarget] =
    useState<PrototypeProjectDropTargetState | null>(null);
  const prototypeProjectRowRefs = useRef(new Map<string, HTMLDivElement>());
  const prototypeProjectPointerDragRef =
    useRef<PrototypeProjectPointerDragState | null>(null);
  const prototypeProjectPointerDragCleanupRef = useRef<(() => void) | null>(
    null,
  );
  const suppressPrototypeProjectClickRef = useRef(false);
  const suppressPrototypeProjectClickResetRef = useRef<number | null>(null);

  const getPrototypeProjectTargets =
    useCallback((): SidebarProjectReorderTarget[] => {
      return projects.flatMap((project) => {
        const element = prototypeProjectRowRefs.current.get(project.id);
        if (!element) return [];
        return [
          { projectId: project.id, rect: element.getBoundingClientRect() },
        ];
      });
    }, [projects]);

  const getPrototypeProjectDropTarget = useCallback(
    (draggedProjectId: string, clientX: number, clientY: number) =>
      findSidebarProjectReorderTarget(
        getPrototypeProjectTargets(),
        draggedProjectId,
        clientX,
        clientY,
      ),
    [getPrototypeProjectTargets],
  );

  const clearPrototypeProjectPointerDragListeners = useCallback(() => {
    prototypeProjectPointerDragCleanupRef.current?.();
    prototypeProjectPointerDragCleanupRef.current = null;
  }, []);

  const endPrototypeProjectPointerDrag = useCallback(() => {
    clearPrototypeProjectPointerDragListeners();
    prototypeProjectPointerDragRef.current = null;
    setDraggedPrototypeProjectId(null);
    setPrototypeProjectDropTarget(null);
    if (suppressPrototypeProjectClickRef.current) {
      schedulePointerDragClickSuppressionReset(
        suppressPrototypeProjectClickRef,
        suppressPrototypeProjectClickResetRef,
      );
    }
  }, [clearPrototypeProjectPointerDragListeners]);

  useEffect(() => {
    return () => {
      prototypeProjectPointerDragCleanupRef.current?.();
      clearPointerDragClickSuppression(
        suppressPrototypeProjectClickRef,
        suppressPrototypeProjectClickResetRef,
      );
    };
  }, []);

  const handlePrototypeProjectPointerDown = useCallback(
    (projectId: string, event: ReactPointerEvent<HTMLDivElement>) => {
      if (!onReorderProject || prototypePrimaryCollapsed) return;
      if (!isPrimaryPointerButton(event)) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          '[data-prototype-nav-menu-trigger="true"], [data-sidebar-drag-ignore], [data-sidebar-chat-draggable]',
        )
      ) {
        return;
      }

      clearPrototypeProjectPointerDragListeners();
      prototypeProjectPointerDragRef.current = {
        dragging: false,
        pointerId: event.pointerId,
        projectId,
        startX: event.clientX,
        startY: event.clientY,
      };

      const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
        const drag = prototypeProjectPointerDragRef.current;
        if (!drag || moveEvent.pointerId !== drag.pointerId) return;

        const isDragging =
          drag.dragging ||
          hasExceededPointerDragThreshold({
            startX: drag.startX,
            startY: drag.startY,
            clientX: moveEvent.clientX,
            clientY: moveEvent.clientY,
          });

        if (!isDragging) return;

        moveEvent.preventDefault();
        suppressPrototypeProjectClickRef.current = true;
        if (!drag.dragging) {
          prototypeProjectPointerDragRef.current = {
            ...drag,
            dragging: true,
          };
          setDraggedPrototypeProjectId(drag.projectId);
        }

        setPrototypeProjectDropTarget(
          getPrototypeProjectDropTarget(
            drag.projectId,
            moveEvent.clientX,
            moveEvent.clientY,
          ),
        );
      };

      const handlePointerUp = (upEvent: globalThis.PointerEvent) => {
        const drag = prototypeProjectPointerDragRef.current;
        if (!drag || upEvent.pointerId !== drag.pointerId) return;

        if (drag.dragging) {
          upEvent.preventDefault();
          const finalTarget = getPrototypeProjectDropTarget(
            drag.projectId,
            upEvent.clientX,
            upEvent.clientY,
          );
          if (finalTarget) {
            onReorderProject(
              drag.projectId,
              finalTarget.projectId,
              finalTarget.placement,
            );
          }
        }
        endPrototypeProjectPointerDrag();
      };

      const handlePointerCancel = (cancelEvent: globalThis.PointerEvent) => {
        const drag = prototypeProjectPointerDragRef.current;
        if (!drag || cancelEvent.pointerId !== drag.pointerId) return;
        endPrototypeProjectPointerDrag();
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerCancel);
      prototypeProjectPointerDragCleanupRef.current = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerCancel);
      };
    },
    [
      clearPrototypeProjectPointerDragListeners,
      endPrototypeProjectPointerDrag,
      getPrototypeProjectDropTarget,
      onReorderProject,
      prototypePrimaryCollapsed,
    ],
  );

  const updatePrototypePrimaryChatPreviewLimit = useCallback(() => {
    if (!prototypeChatsUnderProjects) {
      setPrototypePrimaryChatPreviewLimit(
        NAV_PROTOTYPE_PRIMARY_CHAT_PREVIEW_FALLBACK_LIMIT,
      );
      return;
    }

    const scrollElement = prototypePrimaryScrollRef.current;
    if (!scrollElement) return;

    const scrollRect = scrollElement.getBoundingClientRect();
    const scrollHeight = scrollRect.height || scrollElement.clientHeight;
    if (scrollHeight <= 0) return;

    const scrollBottom = scrollRect.bottom || scrollRect.top + scrollHeight;
    const navGroupHeight =
      prototypePrimaryNavGroupRef.current?.getBoundingClientRect().height ?? 0;
    const projectsGroupHeight =
      prototypePrimaryProjectsGroupRef.current?.getBoundingClientRect()
        .height ?? 0;
    const reservedChatSectionHeight =
      NAV_PROTOTYPE_ROW_HEIGHT_PX * 3 + NAV_PROTOTYPE_ROW_GAP_PX * 2;
    const chatsGroupRect =
      prototypePrimaryChatsGroupRef.current?.getBoundingClientRect();
    const chatSectionHeight =
      chatsGroupRect &&
      (chatsGroupRect.height > 0 || chatsGroupRect.top > scrollRect.top)
        ? scrollBottom - chatsGroupRect.top
        : scrollHeight -
          navGroupHeight -
          NAV_PROTOTYPE_PROJECTS_SECTION_TOP_MARGIN_PX -
          projectsGroupHeight -
          NAV_PROTOTYPE_CHAT_SECTION_TOP_MARGIN_PX;
    const availableRowsHeight = chatSectionHeight - reservedChatSectionHeight;
    const nextLimit = Math.max(
      0,
      Math.min(
        looseVisiblePrototypeChatSessions.length,
        Math.floor(
          (availableRowsHeight + NAV_PROTOTYPE_ROW_GAP_PX) /
            (NAV_PROTOTYPE_ROW_HEIGHT_PX + NAV_PROTOTYPE_ROW_GAP_PX),
        ),
      ),
    );

    setPrototypePrimaryChatPreviewLimit((currentLimit) =>
      currentLimit === nextLimit ? currentLimit : nextLimit,
    );
  }, [looseVisiblePrototypeChatSessions.length, prototypeChatsUnderProjects]);

  useLayoutEffect(() => {
    if (!isPrototype || !prototypeChatsUnderProjects) {
      setPrototypePrimaryChatPreviewLimit(
        NAV_PROTOTYPE_PRIMARY_CHAT_PREVIEW_FALLBACK_LIMIT,
      );
      return;
    }

    updatePrototypePrimaryChatPreviewLimit();

    const observedElements = [
      prototypePrimaryScrollRef.current,
      prototypePrimaryNavGroupRef.current,
      prototypePrimaryProjectsGroupRef.current,
    ].filter((element): element is HTMLDivElement => Boolean(element));
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(updatePrototypePrimaryChatPreviewLimit);

    for (const element of observedElements) {
      resizeObserver?.observe(element);
    }
    window.addEventListener("resize", updatePrototypePrimaryChatPreviewLimit);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener(
        "resize",
        updatePrototypePrimaryChatPreviewLimit,
      );
    };
  }, [
    isPrototype,
    prototypeChatsUnderProjects,
    updatePrototypePrimaryChatPreviewLimit,
  ]);

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
  const useUnifiedDefaultNavigation = !isPrototype && !canDetachSessionList;
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
  const activePrototypeProjectId =
    activeView !== "chat" && prototypeSecondaryTarget?.kind === "project"
      ? prototypeSecondaryTarget.projectId
      : null;

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
      if (targetAlreadyOpen && !prototypeSecondaryInteractedRef.current) {
        prototypeSecondaryInteractedRef.current = false;
        setPrototypePreviewTarget(null);
        onPrototypeSecondaryPreviewChange?.(false);
        onPrototypeSecondaryTargetChange?.(null);
        return false;
      }

      if (!targetAlreadyOpen) {
        prototypeSecondaryInteractedRef.current = false;
      }

      const targetIsCurrentPreview =
        prototypePreviewTarget !== null &&
        navigationSecondaryTargetsEqual(target, prototypePreviewTarget);
      const shouldPreview = Boolean(
        options.preview && (!targetAlreadyOpen || targetIsCurrentPreview),
      );

      setPrototypePreviewTarget(shouldPreview ? target : null);
      onPrototypeSecondaryPreviewChange?.(shouldPreview);
      onPrototypeSecondaryTargetChange?.(target);
      return true;
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
  const markPrototypeSecondaryInteracted = useCallback(() => {
    prototypeSecondaryInteractedRef.current = true;
  }, []);
  const commitPrototypeSecondaryInteraction = useCallback(() => {
    markPrototypeSecondaryInteracted();
    commitPrototypePreview();
  }, [commitPrototypePreview, markPrototypeSecondaryInteracted]);
  const handlePrototypeSecondarySelect = useCallback(() => {
    markPrototypeSecondaryInteracted();
    onPrototypeSecondarySelect?.();
  }, [markPrototypeSecondaryInteracted, onPrototypeSecondarySelect]);
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
      prototypeSecondaryInteractedRef.current = true;
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
      prototypeSecondaryInteractedRef.current = false;
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

  const getPrototypePaneResizeStartWidth = useCallback(
    (paneId: PrototypeResizablePaneId) =>
      paneId === "primary" ? prototypePrimaryWidth : prototypeSecondaryWidth,
    [prototypePrimaryWidth, prototypeSecondaryWidth],
  );
  const handlePrototypePaneResize = useCallback(
    (paneId: PrototypeResizablePaneId, nextWidth: number) => {
      if (paneId === "primary") {
        onPrototypePrimaryWidthResize?.(nextWidth);
        return;
      }

      onPrototypeSecondaryWidthResize?.(nextWidth);
    },
    [onPrototypePrimaryWidthResize, onPrototypeSecondaryWidthResize],
  );
  const handlePrototypePaneResizeBegin = useCallback(() => {
    prototypeResizeActiveRef.current = true;
    if (prototypeSecondaryTarget) {
      markPrototypeSecondaryInteracted();
    }
    clearPrototypePreviewCloseTimeout();

    if (prototypeSecondaryTarget) {
      setPrototypePreviewTarget(null);
      onPrototypeSecondaryPreviewChange?.(false);
      onPrototypeSecondarySelect?.();
    }
  }, [
    clearPrototypePreviewCloseTimeout,
    markPrototypeSecondaryInteracted,
    onPrototypeSecondaryPreviewChange,
    onPrototypeSecondarySelect,
    prototypeSecondaryTarget,
  ]);
  const handlePrototypePaneResizeEnd = useCallback(() => {
    prototypeResizeActiveRef.current = false;
  }, []);
  const handlePrototypePaneResizeStart =
    usePaneResize<PrototypeResizablePaneId>({
      enabled:
        isPrototype &&
        Boolean(
          onPrototypePrimaryWidthResize || onPrototypeSecondaryWidthResize,
        ),
      getStartWidth: getPrototypePaneResizeStartWidth,
      onResize: handlePrototypePaneResize,
      onResizeBegin: handlePrototypePaneResizeBegin,
      onResizeEnd: handlePrototypePaneResizeEnd,
    });

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

    prototypeSecondaryInteractedRef.current = false;

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
  const renderPrototypeResizeRail = (
    paneId: PrototypeResizablePaneId,
    title: string,
  ) => (
    <PaneResizeRail
      dividerClassName={
        paneId === "primary"
          ? "h-full group-hover/pane-resize:bg-border/70"
          : undefined
      }
      surfaceId={paneId}
      testId={`sidebar-prototype-resize-${paneId}`}
      onResizeStart={handlePrototypePaneResizeStart}
      title={title}
    />
  );

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
    const omittedSecondaryChatSessionIds =
      renderedPrototypeSecondaryTarget?.kind === "chats" &&
      prototypeChatsUnderProjects
        ? prototypePrimaryChatSessions.map((session) => session.id)
        : undefined;
    const secondaryPanel = renderedPrototypeSecondaryTarget ? (
      <div
        ref={prototypeSecondaryPanelRef}
        className={cn(
          "relative h-full flex-shrink-0 overflow-visible",
          prototypeSecondaryClosing && "pointer-events-none",
        )}
        onClickCapture={(event) => {
          const target = event.target;
          if (
            target instanceof Element &&
            target.closest("[data-sidebar-drag-ignore]")
          ) {
            return;
          }
          markPrototypeSecondaryInteracted();
          commitPrototypePreview();
          if (!prototypeNavMenuOpenRef.current) {
            collapsePrototypePrimary();
          }
        }}
        onPointerEnter={() => {
          clearPrototypePreviewCloseTimeout();
          prototypeSecondaryHoverRef.current = true;
        }}
        onPointerLeave={(event) => {
          if (prototypeNavMenuOpenRef.current) {
            clearPrototypePreviewCloseTimeout();
            return;
          }
          if (prototypeResizeActiveRef.current) {
            clearPrototypePreviewCloseTimeout();
            return;
          }

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
            chatRowBehavior={prototypeChatRowBehavior}
            onCreateProject={onCreateProject}
            onEditProject={onEditProject}
            onArchiveChat={onArchiveChat}
            onCommitPreview={commitPrototypeSecondaryInteraction}
            onNavigationMenuOpenChange={(open) => {
              prototypeNavMenuOpenRef.current = open;
            }}
            onNavigate={onNavigate}
            onMoveToProject={onMoveToProject}
            onNewChatInProject={onNewChatInProject}
            onOpenSettingsSection={onOpenSettingsSection}
            onSecondarySelect={handlePrototypeSecondarySelect}
            onSelectSession={onSelectSession}
            onShowChatIconsChange={setShowPrototypeChatIcons}
            onShowChatTimestampsChange={setShowPrototypeChatTimestamps}
            onUpdateProjectChatGroups={onUpdateProjectChatGroups}
            omittedChatSessionIds={omittedSecondaryChatSessionIds}
            prototypeChatsUnderProjects={prototypeChatsUnderProjects}
            projects={projects}
            search={prototypeChatSearch}
            secondaryTarget={renderedPrototypeSecondaryTarget}
            sessions={sessions}
            settingsSections={visibleSettingsSections}
            setSearch={setPrototypeChatSearch}
            showChatIcons={showPrototypeChatIcons}
            showChatTimestamps={showPrototypeChatTimestamps}
            resizeRail={
              onPrototypeSecondaryWidthResize
                ? renderPrototypeResizeRail("secondary", "Resize panel")
                : undefined
            }
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
          data-testid="sidebar-prototype-secondary-overlay"
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
      prototypeSecondaryInteractedRef.current = false;
      setPrototypePreviewTarget(null);
      onPrototypeSecondaryPreviewChange?.(false);
      onPrototypeSecondaryTargetChange?.(null);
      onNavigate?.(view);
    };
    const openPrototypeChatsSecondary = ({
      preview,
      variant,
    }: {
      preview?: boolean;
      variant?: NavigationChatsSecondaryVariant;
    } = {}) => {
      return openPrototypeSecondary(
        variant ? { kind: "chats", variant } : { kind: "chats" },
        { preview },
      );
    };
    const openPrototypeProjectSecondary = (
      projectId: string,
      options?: { preview?: boolean },
    ) => {
      return openPrototypeSecondary({ kind: "project", projectId }, options);
    };
    const openPrototypeSettingsSecondary = (options?: {
      preview?: boolean;
    }) => {
      return openPrototypeSecondary({ kind: "settings" }, options);
    };
    const selectPrototypeSettingsSecondary = () => {
      if (openPrototypeSettingsSecondary()) {
        onPrototypeSecondarySelect?.();
      }
    };
    const confirmArchivePrototypeSelected = () =>
      confirmPrototypeArchiveSelected(
        onArchiveChat
          ? (sessionId) =>
              Promise.resolve(onArchiveChat(sessionId)).then(() => undefined)
          : undefined,
      );

    return (
      <>
        <SidebarChatDragProvider>
          <PaneLayoutFrame
            className={cn(NAV_PROTOTYPE_TRANSITION_CLASS, className)}
            gapPx={NAV_PROTOTYPE_PANEL_GAP_PX}
            height="100%"
            onPointerEnter={clearPrototypePreviewCloseTimeout}
            onPointerLeave={(event) => {
              if (prototypeNavMenuOpenRef.current) {
                clearPrototypePreviewCloseTimeout();
                return;
              }
              if (prototypeResizeActiveRef.current) {
                clearPrototypePreviewCloseTimeout();
                return;
              }

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
                if (prototypeNavMenuOpenRef.current) {
                  clearPrototypePreviewCloseTimeout();
                  return;
                }
                if (prototypeResizeActiveRef.current) {
                  clearPrototypePreviewCloseTimeout();
                  return;
                }

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
                    ref={prototypePrimaryScrollRef}
                    className={cn(
                      "min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-12 scrollbar-none",
                    )}
                    style={
                      prototypeChatsUnderProjects
                        ? undefined
                        : BOTTOM_MASK_STYLE
                    }
                    data-testid="sidebar-prototype-primary-scroll"
                  >
                    <div
                      ref={prototypePrimaryNavGroupRef}
                      className="space-y-px"
                      data-testid="sidebar-prototype-primary-nav-group"
                    >
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
                      <PrototypeNavRow
                        active={activeView === "connections"}
                        collapsed={prototypePrimaryCollapsed}
                        icon={
                          <Link2 className={NAV_PROTOTYPE_LUCIDE_ICON_CLASS} />
                        }
                        label={t("navigation.connections")}
                        onClick={() => handlePrototypeNavigate("connections")}
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
                      {!prototypeChatsUnderProjects ? (
                        <PrototypeNavRow
                          active={
                            activeView === "session-history" ||
                            prototypeSecondaryTarget?.kind === "chats"
                          }
                          collapsed={prototypePrimaryCollapsed}
                          icon={<SidebarNavChatsIcon />}
                          label="Chats"
                          onClick={() => {
                            if (openPrototypeChatsSecondary()) {
                              onPrototypeSecondarySelect?.();
                            }
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
                                <Plus
                                  className={NAV_PROTOTYPE_LUCIDE_ICON_CLASS}
                                />
                              </PrototypeBareActionIcon>
                            </>
                          }
                        />
                      ) : null}
                    </div>

                    <div className="mt-6">
                      <div
                        ref={prototypePrimaryProjectsGroupRef}
                        className="space-y-px"
                        data-testid="sidebar-prototype-projects-group"
                      >
                        <PrototypePrimarySectionHeader
                          collapsed={prototypePrimaryCollapsed}
                          icon={
                            <DefaultProjectGlyphIcon
                              aria-hidden="true"
                              className={cn("size-4", NAV_PROTOTYPE_ICON_CLASS)}
                              style={{ color: "currentColor" }}
                            />
                          }
                          label={t("sections.projects")}
                          testId="sidebar-prototype-projects-section-header"
                          actions={
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
                          }
                        />
                        {projects.map((project) => {
                          const activeProject =
                            activePrototypeProjectId === project.id;
                          return (
                            <div
                              key={project.id}
                              data-sidebar-project-draggable
                              data-project-id={project.id}
                              ref={(element) => {
                                if (element) {
                                  prototypeProjectRowRefs.current.set(
                                    project.id,
                                    element,
                                  );
                                } else {
                                  prototypeProjectRowRefs.current.delete(
                                    project.id,
                                  );
                                }
                              }}
                              onPointerDown={(event) =>
                                handlePrototypeProjectPointerDown(
                                  project.id,
                                  event,
                                )
                              }
                              onClickCapture={(event) => {
                                if (!suppressPrototypeProjectClickRef.current) {
                                  return;
                                }
                                clearPointerDragClickSuppression(
                                  suppressPrototypeProjectClickRef,
                                  suppressPrototypeProjectClickResetRef,
                                );
                                event.preventDefault();
                                event.stopPropagation();
                              }}
                              className={cn(
                                "relative",
                                draggedPrototypeProjectId === project.id &&
                                  "opacity-40",
                              )}
                            >
                              {prototypeProjectDropTarget?.projectId ===
                                project.id &&
                              draggedPrototypeProjectId !== project.id ? (
                                <div
                                  className={cn(
                                    "absolute left-3 right-3 z-10 h-0.5 rounded-full bg-sidebar-foreground",
                                    prototypeProjectDropTarget.placement ===
                                      "after"
                                      ? "bottom-0"
                                      : "top-0",
                                  )}
                                />
                              ) : null}
                              <PrototypeProjectNavRow
                                active={activeProject}
                                collapsed={prototypePrimaryCollapsed}
                                onArchiveProject={onArchiveProject}
                                onClick={() => {
                                  openPrototypeProjectSecondary(project.id, {
                                    preview: true,
                                  });
                                }}
                                onEditProject={onEditProject}
                                onMoveToProject={onMoveToProject}
                                onNewChat={async () => {
                                  openPrototypeProjectSecondary(project.id);
                                  commitPrototypePreview();
                                  await onNewChatInProject?.(project.id, {
                                    reuseExistingDraft: true,
                                  });
                                }}
                                project={project}
                                prototypeNavMenuOpenRef={
                                  prototypeNavMenuOpenRef
                                }
                              />
                            </div>
                          );
                        })}
                      </div>
                      {prototypeChatsUnderProjects ? (
                        <div
                          ref={prototypePrimaryChatsGroupRef}
                          className="relative mt-4 space-y-px"
                          data-testid="sidebar-prototype-chats-group"
                        >
                          <PrototypeRecentsDropTarget
                            onMoveToProject={onMoveToProject}
                            targetKey="prototype-primary-recents"
                          />
                          <PrototypePrimarySectionHeader
                            collapsed={prototypePrimaryCollapsed}
                            icon={
                              <SidebarNavChatsIcon
                                aria-hidden="true"
                                className={cn(
                                  "size-4",
                                  NAV_PROTOTYPE_ICON_CLASS,
                                )}
                              />
                            }
                            label="Chats"
                            testId="sidebar-prototype-chats-section-header"
                            actions={
                              <>
                                <PrototypeBareActionIcon
                                  className={
                                    NAV_PROTOTYPE_SECTION_ACTION_ICON_CLASS
                                  }
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
                                  className={
                                    NAV_PROTOTYPE_SECTION_ACTION_ICON_CLASS
                                  }
                                  label={t("actions.newChat")}
                                  onClick={() => {
                                    commitPrototypePreview();
                                    onNewChat?.();
                                  }}
                                >
                                  <Plus
                                    className={NAV_PROTOTYPE_LUCIDE_ICON_CLASS}
                                  />
                                </PrototypeBareActionIcon>
                              </>
                            }
                          />
                          {!prototypePrimaryCollapsed
                            ? prototypePrimaryChatSessions.map((session) => (
                                <PrototypeSidebarChatRow
                                  key={session.id}
                                  active={activeSessionId === session.id}
                                  behavior={prototypeChatRowBehavior}
                                  contentPaddingClassName={
                                    NAV_PROTOTYPE_EXPANDED_ROW_START_CLASS
                                  }
                                  currentProjectId={null}
                                  leadingIconTestId="prototype-primary-chat-row-icon"
                                  onMenuOpenChange={(open) => {
                                    prototypeNavMenuOpenRef.current = open;
                                  }}
                                  onSelect={(sessionId) => {
                                    commitPrototypePreview();
                                    onSelectSession?.(sessionId, {
                                      suppressPrototypeSecondary:
                                        prototypeChatsUnderProjects,
                                    });
                                  }}
                                  session={session}
                                  showIcon={showPrototypeChatIcons}
                                  showTimestamp={showPrototypeChatTimestamps}
                                />
                              ))
                            : null}
                          <PrototypePrimaryChatRow
                            collapsed={prototypePrimaryCollapsed}
                            icon={
                              <MoreHorizontal
                                className={NAV_PROTOTYPE_LUCIDE_ICON_CLASS}
                              />
                            }
                            label="View more"
                            muted
                            onClick={() => {
                              if (
                                openPrototypeChatsSecondary({ variant: "more" })
                              ) {
                                onPrototypeSecondarySelect?.();
                              }
                            }}
                            showIcon={
                              prototypePrimaryCollapsed ||
                              showPrototypeChatIcons
                            }
                          />
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div className="-mx-2 shrink-0 px-2 pb-2 pt-3">
                    <div className="relative">
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
                {!prototypePrimaryCollapsed && onPrototypePrimaryWidthResize
                  ? renderPrototypeResizeRail("primary", "Resize navigation")
                  : null}
              </PaneSurface>
            </div>
            {prototypeSecondaryInline ? secondaryPanel : null}
          </PaneLayoutFrame>
        </SidebarChatDragProvider>
        <ConfirmDialog
          open={prototypeArchiveConfirmOpen}
          onOpenChange={setPrototypeArchiveConfirmOpen}
          title={t("common:bulkActions.archiveConfirmTitle", {
            count: prototypeArchiveSelectionCount,
            displayCount: prototypeArchiveSelectionCount,
          })}
          description={t("common:bulkActions.archiveConfirmDescription", {
            count: prototypeArchiveSelectionCount,
            displayCount: prototypeArchiveSelectionCount,
          })}
          cancelLabel={t("common:actions.cancel")}
          confirmLabel={t("common:actions.archive")}
          destructive={false}
          loadingLabel={t("common:bulkActions.archiving")}
          isLoading={isApplyingPrototypeSelectionAction}
          onConfirm={confirmArchivePrototypeSelected}
        />
      </>
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
          !collapsed && useUnifiedDefaultNavigation
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
