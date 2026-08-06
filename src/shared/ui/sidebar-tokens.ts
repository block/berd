/**
 * Primary chrome nav labels — sidebar nav items, chat rows, footer actions,
 * and top-bar page-header actions (Import, New Agent, etc.).
 */
export const APP_CHROME_NAV_TEXT_CLASS = "text-sm font-normal leading-normal";

/** Overrides size-xs `text-xs` on page-header buttons in the top bar. */
export const APP_CHROME_NAV_TEXT_IMPORTANT_CLASS =
  "!text-sm !font-normal !leading-normal";

/** @deprecated Use APP_CHROME_NAV_TEXT_CLASS */
export const SIDEBAR_NAV_TEXT_CLASS = APP_CHROME_NAV_TEXT_CLASS;

/** Shared icon-to-label spacing for sidebar nav items and chat rows. */
export const SIDEBAR_ROW_ICON_TEXT_GAP_CLASS = "gap-2";

/** Shared row height for sidebar nav items, project rows, and chat rows. */
export const SIDEBAR_ROW_HEIGHT_CLASS = "h-7";

/** Shared vertical padding for sidebar nav items and chat rows. */
export const SIDEBAR_ROW_VERTICAL_PADDING_CLASS = "py-1";

/** Shared horizontal inset for top-level sidebar rows. */
export const SIDEBAR_ROW_HORIZONTAL_INSET_CLASS = "mx-1.5";

/** Shared horizontal padding for top-level sidebar row content. */
export const SIDEBAR_ROW_HORIZONTAL_PADDING_CLASS = "px-3";

/** Nav row spacing; matches chat row gap and vertical rhythm. */
export const SIDEBAR_NAV_ROW_SPACING_CLASS = `${SIDEBAR_ROW_HEIGHT_CLASS} ${SIDEBAR_ROW_ICON_TEXT_GAP_CLASS} ${SIDEBAR_ROW_HORIZONTAL_PADDING_CLASS} ${SIDEBAR_ROW_VERTICAL_PADDING_CLASS}`;

/** Menu row hover/active background — ease-in-out for fluid feedback. */
export const SIDEBAR_MENU_HOVER_TRANSITION_CLASS =
  "transition-[background-color,color] duration-250 ease-in-out";

/** Default sidebar row text and active/hover fills. */
export const SIDEBAR_ROW_TEXT_DEFAULT_CLASS = "text-sidebar-foreground";
export const SIDEBAR_ROW_HOVER_CLASS =
  "hover:bg-[var(--sidebar-row-hover)] hover:text-sidebar-foreground focus-visible:bg-[var(--sidebar-row-hover)] focus-visible:text-sidebar-foreground";
export const SIDEBAR_ROW_ACTIVE_CLASS =
  "bg-[var(--sidebar-row-active)] text-sidebar-foreground hover:bg-[var(--sidebar-row-active)] hover:text-sidebar-foreground";

/** Raised (dark) popovers used by sidebar row menus. */
export const SIDEBAR_RAISED_MENU_CONTENT_CLASS =
  "w-44 px-1 py-1 text-sm font-normal leading-normal [&_[data-slot=context-menu-item]]:gap-2 [&_[data-slot=context-menu-item]]:rounded-[6px] [&_[data-slot=context-menu-item]]:px-2 [&_[data-slot=context-menu-item]]:py-1 [&_[data-slot=context-menu-item]]:text-sm [&_[data-slot=context-menu-item]]:font-normal [&_[data-slot=context-menu-item]]:leading-normal [&_[data-slot=context-menu-item]]:opacity-[0.85] [&_[data-slot=context-menu-item]:focus]:!text-popover-raised-foreground [&_[data-slot=context-menu-item]:focus]:opacity-100 [&_[data-slot=dropdown-menu-item]]:gap-2 [&_[data-slot=dropdown-menu-item]]:rounded-[6px] [&_[data-slot=dropdown-menu-item]]:px-2 [&_[data-slot=dropdown-menu-item]]:py-1 [&_[data-slot=dropdown-menu-item]]:text-sm [&_[data-slot=dropdown-menu-item]]:font-normal [&_[data-slot=dropdown-menu-item]]:leading-normal [&_[data-slot=dropdown-menu-item]]:opacity-[0.85] [&_[data-slot=dropdown-menu-item]:focus]:!text-popover-raised-foreground [&_[data-slot=dropdown-menu-item]:focus]:opacity-100 [&_[data-slot=dropdown-menu-checkbox-item]]:gap-2 [&_[data-slot=dropdown-menu-checkbox-item]]:rounded-[6px] [&_[data-slot=dropdown-menu-checkbox-item]]:px-2 [&_[data-slot=dropdown-menu-checkbox-item]]:py-1 [&_[data-slot=dropdown-menu-checkbox-item]]:text-sm [&_[data-slot=dropdown-menu-checkbox-item]]:font-normal [&_[data-slot=dropdown-menu-checkbox-item]]:leading-normal [&_[data-slot=dropdown-menu-checkbox-item]]:opacity-[0.85] [&_[data-slot=dropdown-menu-checkbox-item]:focus]:!text-popover-raised-foreground [&_[data-slot=dropdown-menu-checkbox-item]:focus]:opacity-100 [&_[data-slot=context-menu-label]]:px-2 [&_[data-slot=context-menu-label]]:py-1 [&_[data-slot=context-menu-label]]:text-sm [&_[data-slot=context-menu-label]]:font-normal [&_[data-slot=context-menu-label]]:leading-normal [&_[data-slot=dropdown-menu-label]]:px-2 [&_[data-slot=dropdown-menu-label]]:py-1 [&_[data-slot=dropdown-menu-label]]:text-sm [&_[data-slot=dropdown-menu-label]]:font-normal [&_[data-slot=dropdown-menu-label]]:leading-normal";

/** Sidebar panel slide in/out when toggling collapse (AppShell). */
export const SIDEBAR_COLLAPSE_TRANSITION_MS = 320;
export const SIDEBAR_COLLAPSE_TRANSITION_EASE = "cubic-bezier(0.4, 0, 0.2, 1)";

/**
 * How far a resize rail's invisible hitbox may extend *inside* its panel.
 * Rails stay generous on the outside of the edge (empty gutter space) but
 * thin on the inside so they never cover row content (e.g. the Settings row
 * near the sidebar's bottom edge).
 */
export const SIDEBAR_RESIZE_HANDLE_INSIDE_PX = 6;

/** Micro section labels in sidebar surfaces (Pinned, design-system groups). */
export const SIDEBAR_NAV_MICRO_LABEL_TEXT_CLASS =
  "text-xs font-normal normal-case tracking-normal";

/** Section headers such as Projects and Chats. */
export const SIDEBAR_GROUP_LABEL_TEXT_CLASS =
  "text-sm font-normal leading-normal";

/** Hover elevation shadow for floating surfaces (e.g. global composer pill). */
export const SIDEBAR_PANEL_ELEVATED_HOVER_SHADOW_CLASS =
  "hover:shadow-sidebar-panel-elevated";

/** Top inset for the primary navigation surface. */
export const SIDEBAR_PRIMARY_NAV_TOP_INSET_CLASS = "pt-[3px]";

/** Horizontal inset for sidebar section divider lines. */
export const SIDEBAR_SECTION_DIVIDER_INSET_CLASS = "mx-3";

/** Section header row padding; aligns labels and actions with divider ends. */
export const SIDEBAR_SECTION_HEADER_PADDING_CLASS =
  SIDEBAR_ROW_HORIZONTAL_PADDING_CLASS;

/** Projects / Chats subheading row spacing. */
export const SIDEBAR_SECTION_HEADER_ROW_CLASS = `${SIDEBAR_SECTION_HEADER_PADDING_CLASS} pt-3.5 pb-0`;

/** Standalone chat row left padding; aligns with section divider inset. */
export const SIDEBAR_CHAT_ROW_PADDING_CLASS = "pl-3";

/** Density variants for chat rows. Default preserves grouped sidebar rhythm. */
export type SidebarChatRowDensity = "default" | "dense";

export const SIDEBAR_CHAT_ROW_DENSITY_CLASSES = {
  default: {
    contentPadding: SIDEBAR_CHAT_ROW_PADDING_CLASS,
    menuReserve: "pr-8",
    timestampReserve: "pr-12",
    menuInset: "right-3",
    flatProjectGap: "gap-1",
    flatProjectIconInset: "ml-3",
    flatProjectIconColumn: "size-5",
  },
  dense: {
    contentPadding: "pl-1",
    // Dense only tightens the left side; the right edge keeps the same
    // inset as default so flat and grouped views align at the panel edge.
    menuReserve: "pr-8",
    timestampReserve: "pr-12",
    menuInset: "right-3",
    flatProjectGap: SIDEBAR_ROW_ICON_TEXT_GAP_CLASS,
    // Align the flat project icon with main-nav icons (px-3 row inset).
    flatProjectIconInset: "ml-3",
    flatProjectIconColumn: "size-5",
  },
} satisfies Record<
  SidebarChatRowDensity,
  {
    contentPadding: string;
    menuReserve: string;
    timestampReserve: string;
    menuInset: string;
    flatProjectGap: string;
    flatProjectIconInset: string;
    flatProjectIconColumn: string;
  }
>;

/** Bare unread dot; the parent owns positioning (e.g. a row's icon slot). */
export const SIDEBAR_UNREAD_DOT_CLASS =
  "pointer-events-none h-[7px] w-[7px] rounded-full bg-success transition-opacity duration-200 ease-out animate-in fade-in-0";

/** Vertical offset above sidebar section divider lines (24px). */
export const SIDEBAR_SECTION_DIVIDER_TOP_CLASS = "mt-6";

export const SIDEBAR_SECTION_DIVIDER_CLASS = `${SIDEBAR_SECTION_DIVIDER_INSET_CLASS} ${SIDEBAR_SECTION_DIVIDER_TOP_CLASS}`;

/** Elevated sidebar panel shadow (panel hover); uses --shadow-sidebar-panel-elevated. */
export const SIDEBAR_PANEL_ELEVATED_SHADOW_CLASS =
  "shadow-sidebar-panel-elevated";
