import { NAVIGATION_PANES_COMBINED_LAYOUT } from "./paneLayoutState";
import { APP_SHELL_PANE_REGISTRY } from "./paneRegistry";
import type {
  AppShellPaneId,
  PaneGroupSizeRule,
  PaneLayoutState,
  PaneSizeConstraint,
  NavigationPaneSizeId,
  NavigationPaneSizes,
  NavigationResizablePaneId,
} from "./paneTypes";

export {
  SIDEBAR_CHAT_LIST_MAX_WIDTH_PX,
  SIDEBAR_CHAT_LIST_MIN_WIDTH_PX,
  SIDEBAR_PRIMARY_NAV_COMPACT_WIDTH_PX,
  SIDEBAR_PRIMARY_NAV_EXPANDED_WIDTH_PX,
} from "./paneRegistry";

const NAVIGATION_PANE_STACK_GROUP_ID = "navigationPaneStack";

type PaneWidthBounds = {
  minPx: number;
  maxPx: number;
};

function clampWidth(width: number, bounds: PaneWidthBounds) {
  return Math.min(bounds.maxPx, Math.max(bounds.minPx, width));
}

function resolvePaneSizeConstraint(
  constraint: PaneSizeConstraint,
  sizePx: number,
) {
  if (constraint.kind === "range") {
    return clampWidth(sizePx, constraint);
  }

  let resolvedSize = constraint.valuesPx[0] ?? sizePx;
  let resolvedDistance = Number.POSITIVE_INFINITY;

  for (const value of constraint.valuesPx) {
    const distance = Math.abs(sizePx - value);
    if (
      distance < resolvedDistance ||
      (distance === resolvedDistance && value > resolvedSize)
    ) {
      resolvedSize = value;
      resolvedDistance = distance;
    }
  }

  return resolvedSize;
}

function getPaneWidthConstraint(paneId: AppShellPaneId) {
  return APP_SHELL_PANE_REGISTRY[paneId].width;
}

function getPaneMinWidth(paneId: AppShellPaneId) {
  const constraint = getPaneWidthConstraint(paneId);
  return constraint.kind === "range"
    ? constraint.minPx
    : Math.min(...constraint.valuesPx);
}

function getPaneMaxWidth(paneId: AppShellPaneId) {
  const constraint = getPaneWidthConstraint(paneId);
  return constraint.kind === "range"
    ? constraint.maxPx
    : Math.max(...constraint.valuesPx);
}

function getPaneSharedWidthBounds(paneId: AppShellPaneId): PaneWidthBounds {
  const constraint = getPaneWidthConstraint(paneId);

  if (constraint.kind === "range") {
    return {
      minPx: constraint.minPx,
      maxPx: constraint.maxPx,
    };
  }

  return {
    minPx: constraint.defaultPx,
    maxPx: constraint.defaultPx,
  };
}

function getSharedWidthRule(
  layout: PaneLayoutState,
  groupId: string,
): PaneGroupSizeRule {
  const group = layout.groups.find((candidate) => candidate.id === groupId);
  const widthRule =
    group?.kind === "stack"
      ? group.sizeRules?.find(
          (rule) => rule.kind === "shared-max" && rule.axis === "width",
        )
      : undefined;

  if (!widthRule) {
    throw new Error(`No shared width rule declared for pane group ${groupId}`);
  }

  return widthRule;
}

export function getPaneGroupSharedWidthBounds(
  layout: PaneLayoutState,
  groupId: string,
): PaneWidthBounds {
  const rule = getSharedWidthRule(layout, groupId);
  const bounds = rule.panes.map(getPaneSharedWidthBounds);

  return {
    minPx: Math.max(...bounds.map((candidate) => candidate.minPx)),
    maxPx: Math.max(...bounds.map((candidate) => candidate.maxPx)),
  };
}

export function resolvePaneWidth(paneId: AppShellPaneId, width: number) {
  return resolvePaneSizeConstraint(getPaneWidthConstraint(paneId), width);
}

export function resolvePaneGroupSharedWidth(
  layout: PaneLayoutState,
  groupId: string,
  width: number,
) {
  return clampWidth(width, getPaneGroupSharedWidthBounds(layout, groupId));
}

export function resolvePaneGroupSharedWidthSizes(
  layout: PaneLayoutState,
  groupId: string,
  width: number,
): Partial<Record<AppShellPaneId, number>> {
  const rule = getSharedWidthRule(layout, groupId);
  const sharedWidth = resolvePaneGroupSharedWidth(layout, groupId, width);

  return Object.fromEntries(
    rule.panes.map((paneId) => [paneId, sharedWidth]),
  ) as Partial<Record<AppShellPaneId, number>>;
}

const sidebarStackedWidthBounds = getPaneGroupSharedWidthBounds(
  NAVIGATION_PANES_COMBINED_LAYOUT,
  NAVIGATION_PANE_STACK_GROUP_ID,
);

export const SIDEBAR_STACKED_MIN_WIDTH_PX = sidebarStackedWidthBounds.minPx;
export const SIDEBAR_STACKED_MAX_WIDTH_PX = sidebarStackedWidthBounds.maxPx;

export function resolveNavigationPaneWidth(
  paneId: NavigationPaneSizeId,
  width: number,
) {
  return resolvePaneWidth(paneId, width);
}

export function resolveStackedNavigationPaneSizes(
  width: number,
): NavigationPaneSizes {
  const sizes = resolvePaneGroupSharedWidthSizes(
    NAVIGATION_PANES_COMBINED_LAYOUT,
    NAVIGATION_PANE_STACK_GROUP_ID,
    width,
  );

  return {
    primaryNav: sizes.primaryNav ?? SIDEBAR_STACKED_MIN_WIDTH_PX,
    chatList: sizes.chatList ?? SIDEBAR_STACKED_MIN_WIDTH_PX,
  };
}

export function resolveIndependentNavigationPaneSizes(
  sizes: NavigationPaneSizes,
): NavigationPaneSizes {
  return {
    primaryNav: resolveNavigationPaneWidth("primaryNav", sizes.primaryNav),
    chatList: resolveNavigationPaneWidth("chatList", sizes.chatList),
  };
}

export function resolveSideBySideNavigationPaneSizesForAvailableWidth(
  sizes: NavigationPaneSizes,
  availableWidth: number,
  gapPx: number,
): NavigationPaneSizes {
  const independentSizes = resolveIndependentNavigationPaneSizes(sizes);
  const availablePaneWidth = Math.max(0, availableWidth - gapPx);

  if (
    independentSizes.primaryNav + independentSizes.chatList <=
    availablePaneWidth
  ) {
    return independentSizes;
  }

  const primaryNavCompactWidth = getPaneMinWidth("primaryNav");
  const primaryNavExpandedWidth = getPaneMaxWidth("primaryNav");
  const chatListMinWidth = getPaneMinWidth("chatList");

  if (availablePaneWidth >= primaryNavExpandedWidth + chatListMinWidth) {
    return {
      primaryNav: primaryNavExpandedWidth,
      chatList: resolveNavigationPaneWidth(
        "chatList",
        availablePaneWidth - primaryNavExpandedWidth,
      ),
    };
  }

  return {
    primaryNav: primaryNavCompactWidth,
    chatList: resolveNavigationPaneWidth(
      "chatList",
      availablePaneWidth - primaryNavCompactWidth,
    ),
  };
}

export function resolveNavigationPaneResizeSurfaceSizes(
  surfaceId: NavigationResizablePaneId,
  width: number,
  currentSizes: NavigationPaneSizes,
): NavigationPaneSizes {
  if (surfaceId === "navigationStack") {
    return resolveStackedNavigationPaneSizes(width);
  }

  return {
    ...currentSizes,
    [surfaceId]: resolveNavigationPaneWidth(surfaceId, width),
  };
}

export function getStackedNavigationPaneWidth(sizes: NavigationPaneSizes) {
  return resolvePaneGroupSharedWidth(
    NAVIGATION_PANES_COMBINED_LAYOUT,
    NAVIGATION_PANE_STACK_GROUP_ID,
    Math.max(sizes.primaryNav, sizes.chatList),
  );
}

export function isPrimaryNavCompactWidth(width: number) {
  return width === resolveNavigationPaneWidth("primaryNav", 0);
}

export function getDefaultNavigationPaneSizes(
  baseNavigationWidth: number,
): NavigationPaneSizes {
  return {
    primaryNav: getPaneWidthConstraint("primaryNav").defaultPx,
    chatList: resolveNavigationPaneWidth("chatList", baseNavigationWidth),
  };
}
