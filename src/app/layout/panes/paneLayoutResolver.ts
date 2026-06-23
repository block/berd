import {
  APP_SHELL_PANE_DRAG_RULES,
  type PaneDragRule,
} from "./paneLayoutRules";
import {
  APP_SHELL_PANE_LAYOUTS,
  NAVIGATION_PANES_COMBINED_LAYOUT,
  NAVIGATION_PANES_SPLIT_LAYOUT,
} from "./paneLayoutState";
import type {
  ChatListPaneDock,
  PaneDragReleaseIntent,
  PaneLayoutState,
} from "./paneTypes";

function getDragDelta(intent: PaneDragReleaseIntent, axis: "x" | "y") {
  return axis === "x"
    ? intent.currentClientX - intent.startClientX
    : intent.currentClientY - intent.startClientY;
}

function isThresholdMet(rule: PaneDragRule, intent: PaneDragReleaseIntent) {
  const delta = getDragDelta(intent, rule.threshold.axis);
  const requiredDelta = Math.max(
    rule.threshold.minDeltaPx,
    intent.surfaceWidth * (rule.threshold.minSurfaceRatio ?? 0),
  );

  return rule.threshold.direction === "positive"
    ? delta > requiredDelta
    : -delta > requiredDelta;
}

function getMatchingPaneDragRule(
  layout: PaneLayoutState,
  intent: PaneDragReleaseIntent,
  dragRules: readonly PaneDragRule[],
) {
  if (!intent.hasSeparated) {
    return undefined;
  }

  return dragRules.find(
    (rule) =>
      rule.sourcePaneId === intent.paneId &&
      rule.fromLayoutId === layout.id &&
      isThresholdMet(rule, intent),
  );
}

export function resolvePaneDragRelease(
  layout: PaneLayoutState,
  intent: PaneDragReleaseIntent,
  dragRules: readonly PaneDragRule[] = APP_SHELL_PANE_DRAG_RULES,
): PaneLayoutState {
  const matchingRule = getMatchingPaneDragRule(layout, intent, dragRules);

  return matchingRule
    ? APP_SHELL_PANE_LAYOUTS[matchingRule.toLayoutId]
    : layout;
}

export function getChatListDockFromLayout(
  layout: PaneLayoutState,
): ChatListPaneDock {
  const chatListAnchor = layout.placements.chatList.anchor;
  return chatListAnchor.kind === "pane" &&
    chatListAnchor.paneId === "primaryNav" &&
    chatListAnchor.edge === "right"
    ? "side"
    : "stacked";
}

export function getDropDockForPaneDrag(
  layout: PaneLayoutState,
  intent: PaneDragReleaseIntent,
  dragRules: readonly PaneDragRule[] = APP_SHELL_PANE_DRAG_RULES,
): ChatListPaneDock | null {
  const matchingRule = getMatchingPaneDragRule(layout, intent, dragRules);

  if (!matchingRule || matchingRule.toLayoutId === layout.id) {
    return null;
  }

  return getChatListDockFromLayout(
    APP_SHELL_PANE_LAYOUTS[matchingRule.toLayoutId],
  );
}

export function getPaneLayoutByChatListDock(
  dock: ChatListPaneDock,
): PaneLayoutState {
  return dock === "side"
    ? NAVIGATION_PANES_SPLIT_LAYOUT
    : NAVIGATION_PANES_COMBINED_LAYOUT;
}
