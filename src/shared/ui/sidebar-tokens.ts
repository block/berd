/** Primary sidebar navigation labels (nav items, chat rows, footer actions). */
export const SIDEBAR_NAV_TEXT_CLASS = "text-sm font-normal";

/** Menu row hover/active background — ease-in-out for fluid feedback. */
export const SIDEBAR_MENU_HOVER_TRANSITION_CLASS =
  "transition-[background-color,color] duration-250 ease-in-out";

/** Sidebar panel slide in/out when toggling collapse (AppShell). */
export const SIDEBAR_COLLAPSE_TRANSITION_MS = 320;
export const SIDEBAR_COLLAPSE_TRANSITION_EASE = "cubic-bezier(0.4, 0, 0.2, 1)";

/** Micro section labels in sidebar surfaces (Pinned, design-system groups). */
export const SIDEBAR_NAV_MICRO_LABEL_TEXT_CLASS =
  "text-[10px] font-normal normal-case tracking-normal";

/** Section headers such as Projects and Chats. */
export const SIDEBAR_GROUP_LABEL_TEXT_CLASS = "text-xs font-normal";

/** Hover elevation shadow for floating surfaces (e.g. global composer pill). */
export const SIDEBAR_PANEL_ELEVATED_HOVER_SHADOW_CLASS =
  "hover:shadow-sidebar-panel-elevated";

/** Horizontal inset for sidebar section divider lines (14px each side). */
export const SIDEBAR_SECTION_DIVIDER_INSET_CLASS = "mx-3.5";

/** Section header row padding; aligns labels and actions with divider ends. */
export const SIDEBAR_SECTION_HEADER_PADDING_CLASS = "pl-3.5 pr-3.5";

/** Projects / Chats subheading row spacing (4px less space below than prior pb-1.5). */
export const SIDEBAR_SECTION_HEADER_ROW_CLASS = `${SIDEBAR_SECTION_HEADER_PADDING_CLASS} pt-0.5 pb-0.5`;

/** Standalone chat row left padding; aligns with section divider inset. */
export const SIDEBAR_CHAT_ROW_PADDING_CLASS = "pl-3.5";

/** Unread dot on the right, aligned with section divider inset. */
export const SIDEBAR_UNREAD_DOT_CLASS =
  "pointer-events-none absolute right-3.5 top-1/2 h-[7px] w-[7px] translate-y-[calc(-50%+1px)] rounded-full bg-success transition-opacity duration-200 ease-out animate-in fade-in-0";

/** Projects / Chats header action pill; colors are scoped sidebar tokens. */
export const SIDEBAR_SECTION_ACTION_PILL_CLASS =
  "h-5 flex-shrink-0 rounded-full bg-sidebar-section-action-bg px-2 text-[11px] font-normal text-sidebar-section-action-fg transition-[background-color,color] duration-150 ease-out hover:bg-sidebar-section-action-bg-hover hover:text-sidebar-section-action-fg-hover";

/** Vertical offset above sidebar section divider lines (24px). */
export const SIDEBAR_SECTION_DIVIDER_TOP_CLASS = "mt-6";

export const SIDEBAR_SECTION_DIVIDER_CLASS = `${SIDEBAR_SECTION_DIVIDER_INSET_CLASS} ${SIDEBAR_SECTION_DIVIDER_TOP_CLASS} border-t border-border`;

/** Elevated sidebar panel shadow (panel hover); uses --shadow-sidebar-panel-elevated. */
export const SIDEBAR_PANEL_ELEVATED_SHADOW_CLASS =
  "shadow-sidebar-panel-elevated";
