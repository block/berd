import type { NavigationPrototypeMode } from "@/app/views/NavigationPanesView";
import type { NavigationSecondaryTarget } from "@/app/views/NavigationPanesView";

export function resolveEffectiveNavigationSecondaryTarget({
  activeChatNavigationSecondaryTarget,
  activeSessionId,
  navigationSecondarySuppressedSessionId,
  navigationSecondaryTarget,
}: {
  activeChatNavigationSecondaryTarget: NavigationSecondaryTarget;
  activeSessionId: string | null;
  navigationSecondarySuppressedSessionId: string | null;
  navigationSecondaryTarget: NavigationSecondaryTarget;
}): NavigationSecondaryTarget {
  if (navigationSecondaryTarget !== null) {
    return navigationSecondaryTarget;
  }

  if (
    activeSessionId !== null &&
    navigationSecondarySuppressedSessionId === activeSessionId
  ) {
    return null;
  }

  return activeChatNavigationSecondaryTarget;
}

export function resolveNavigationPrototypePrimaryCollapsed({
  mode,
  navigationPrimaryHovered,
  prototypePrimaryDefaultExpanded,
  prototypePrimaryRestCollapsed,
  prototypeSecondaryOpen,
}: {
  mode: NavigationPrototypeMode;
  navigationPrimaryHovered: boolean;
  prototypePrimaryDefaultExpanded?: boolean;
  prototypePrimaryRestCollapsed: boolean;
  prototypeSecondaryOpen: boolean;
}) {
  if (prototypePrimaryDefaultExpanded && !prototypePrimaryRestCollapsed) {
    return false;
  }

  if (mode === "auto-collapse-push") {
    return (
      (prototypeSecondaryOpen || prototypePrimaryRestCollapsed) &&
      !navigationPrimaryHovered
    );
  }

  if (mode === "hybrid-push-overlay" || mode === "manual-float") {
    return !navigationPrimaryHovered;
  }

  return false;
}
