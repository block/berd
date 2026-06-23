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
export const SIDEBAR_ROW_HEIGHT_CLASS = "h-[30px]";

/** Shared vertical padding for sidebar nav items and chat rows. */
export const SIDEBAR_ROW_VERTICAL_PADDING_CLASS = "py-1";

/** Shared horizontal padding for top-level sidebar rows. */
export const SIDEBAR_ROW_HORIZONTAL_PADDING_CLASS = "px-3";

/** Nav row spacing; matches chat row gap and vertical rhythm. */
export const SIDEBAR_NAV_ROW_SPACING_CLASS = `${SIDEBAR_ROW_HEIGHT_CLASS} ${SIDEBAR_ROW_ICON_TEXT_GAP_CLASS} ${SIDEBAR_ROW_HORIZONTAL_PADDING_CLASS} ${SIDEBAR_ROW_VERTICAL_PADDING_CLASS}`;

/** Menu row hover/active background — ease-in-out for fluid feedback. */
export const SIDEBAR_MENU_HOVER_TRANSITION_CLASS =
  "transition-[background-color,color] duration-250 ease-in-out";

/** Sidebar panel slide in/out when toggling collapse (AppShell). */
export const SIDEBAR_COLLAPSE_TRANSITION_MS = 320;
export const SIDEBAR_COLLAPSE_TRANSITION_EASE = "cubic-bezier(0.4, 0, 0.2, 1)";

/** Micro section labels in sidebar surfaces (Pinned, design-system groups). */
export const SIDEBAR_NAV_MICRO_LABEL_TEXT_CLASS =
  "text-xs font-normal normal-case tracking-normal";

/** Section headers such as Projects and Chats. */
export const SIDEBAR_GROUP_LABEL_TEXT_CLASS = "text-xs font-normal";

/** Hover elevation shadow for floating surfaces (e.g. global composer pill). */
export const SIDEBAR_PANEL_ELEVATED_HOVER_SHADOW_CLASS =
  "hover:shadow-sidebar-panel-elevated";

/** Horizontal inset for sidebar section divider lines. */
export const SIDEBAR_SECTION_DIVIDER_INSET_CLASS = "mx-3";

/** Section header row padding; aligns labels and actions with divider ends. */
export const SIDEBAR_SECTION_HEADER_PADDING_CLASS =
  SIDEBAR_ROW_HORIZONTAL_PADDING_CLASS;

/** Projects / Chats subheading row spacing. */
export const SIDEBAR_SECTION_HEADER_ROW_CLASS = `${SIDEBAR_SECTION_HEADER_PADDING_CLASS} pt-2 pb-0.5`;

/** Standalone chat row left padding; aligns with section divider inset. */
export const SIDEBAR_CHAT_ROW_PADDING_CLASS = "pl-3";

/** Bare unread dot; the parent owns positioning (e.g. a row's icon slot). */
export const SIDEBAR_UNREAD_DOT_CLASS =
  "pointer-events-none h-[7px] w-[7px] rounded-full bg-success transition-opacity duration-200 ease-out animate-in fade-in-0";

/** Projects / Chats header action pill; colors are scoped sidebar tokens. */
export const SIDEBAR_SECTION_ACTION_PILL_CLASS =
  "h-5 flex-shrink-0 rounded-full bg-sidebar-section-action-bg px-2 text-sm font-normal text-sidebar-section-action-fg transition-[background-color,color] duration-150 ease-out hover:bg-sidebar-section-action-bg-hover hover:text-sidebar-section-action-fg-hover";

/** Vertical offset above sidebar section divider lines (24px). */
export const SIDEBAR_SECTION_DIVIDER_TOP_CLASS = "mt-6";

export const SIDEBAR_SECTION_DIVIDER_CLASS = `${SIDEBAR_SECTION_DIVIDER_INSET_CLASS} ${SIDEBAR_SECTION_DIVIDER_TOP_CLASS} border-t border-border`;

/** Elevated sidebar panel shadow (panel hover); uses --shadow-sidebar-panel-elevated. */
export const SIDEBAR_PANEL_ELEVATED_SHADOW_CLASS =
  "shadow-sidebar-panel-elevated";

/** Gap between sibling sidebar panels in the detachable chats experiment. */
export const SIDEBAR_DETACHED_PANEL_GAP_PX = 10;
