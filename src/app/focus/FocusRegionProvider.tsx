import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useShortcutBindings } from "@/features/shortcuts/lib/shortcutRegistry";
import {
  keyboardEventMatchesShortcut,
  normalizeKeyboardShortcut,
  type KeyboardShortcut,
} from "@/shared/keyboard/keyboardShortcut";
import { PaneJumpOverlay } from "./PaneJumpOverlay";

export type FocusRegionId =
  | "sidebar"
  | "main"
  | "context"
  | "terminal"
  | "composer";

export type FocusRegionRegistration = {
  id: FocusRegionId;
  label: string;
  key: string;
  enabled: boolean;
  element: HTMLElement | null;
  getInitialFocus?: () => HTMLElement | null;
};

type RegisteredFocusRegion = FocusRegionRegistration & {
  element: HTMLElement;
  rect: DOMRect;
};

type Direction = "left" | "down" | "up" | "right";

type FocusRegionContextValue = {
  registerRegion: (registration: FocusRegionRegistration) => () => void;
};

const FocusRegionContext = createContext<FocusRegionContextValue | null>(null);
const PANE_JUMP_TIMEOUT_MS = 2500;
/** Layers (modals, radix poppers) that own the keyboard while open;
    global shortcuts should not fire from inside them. */
const KEYBOARD_OWNING_LAYER_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  "[data-radix-popper-content-wrapper]",
  "[data-radix-select-content]",
  "[data-radix-dropdown-menu-content]",
  "[data-radix-context-menu-content]",
].join(",");
const DEFAULT_PANE_JUMP_SHORTCUT = "ctrl+;";

export function normalizePaneJumpShortcut(shortcut: unknown): KeyboardShortcut {
  return normalizeKeyboardShortcut(shortcut, DEFAULT_PANE_JUMP_SHORTCUT);
}

/** True while any modal/popper layer is mounted; global shortcuts should
    stand down regardless of where focus currently sits. */
export function hasOpenKeyboardOwningLayer() {
  return Array.from(
    document.querySelectorAll(KEYBOARD_OWNING_LAYER_SELECTOR),
  ).some((layer) => !layer.querySelector('[data-slot="tooltip-content"]'));
}

function centerOf(rect: DOMRect) {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

function isVisibleFocusRegion(
  registration: FocusRegionRegistration,
): registration is FocusRegionRegistration & { element: HTMLElement } {
  const { element } = registration;
  if (!registration.enabled || !element) {
    return false;
  }

  if (
    element.hidden ||
    element.getAttribute("aria-hidden") === "true" ||
    element.matches("[disabled], [inert]") ||
    element.closest("[aria-hidden='true'], [inert]")
  ) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export function getVisibleFocusRegions(
  registrations: Iterable<FocusRegionRegistration>,
): RegisteredFocusRegion[] {
  return Array.from(registrations)
    .filter(isVisibleFocusRegion)
    .map((registration) => ({
      ...registration,
      rect: registration.element.getBoundingClientRect(),
    }));
}

export function getNearestFocusRegion(
  current: RegisteredFocusRegion,
  regions: RegisteredFocusRegion[],
  direction: Direction,
): RegisteredFocusRegion | null {
  const currentCenter = centerOf(current.rect);
  const candidates = regions.filter((region) => {
    if (region.id === current.id) {
      return false;
    }

    const regionCenter = centerOf(region.rect);
    switch (direction) {
      case "left":
        return regionCenter.x < currentCenter.x;
      case "right":
        return regionCenter.x > currentCenter.x;
      case "up":
        return regionCenter.y < currentCenter.y;
      case "down":
        return regionCenter.y > currentCenter.y;
      default:
        return false;
    }
  });

  return (
    candidates
      .map((region) => {
        const regionCenter = centerOf(region.rect);
        const dx = regionCenter.x - currentCenter.x;
        const dy = regionCenter.y - currentCenter.y;
        const primary =
          direction === "left" || direction === "right"
            ? Math.abs(dx)
            : Math.abs(dy);
        const secondary =
          direction === "left" || direction === "right"
            ? Math.abs(dy)
            : Math.abs(dx);
        return { region, score: primary + secondary * 2 };
      })
      .sort((a, b) => a.score - b.score)[0]?.region ?? null
  );
}

function directionFromKey(key: string): Direction | null {
  switch (key) {
    case "h":
      return "left";
    case "j":
      return "down";
    case "k":
      return "up";
    case "l":
      return "right";
    default:
      return null;
  }
}

function consumePaneJumpKey(event: KeyboardEvent) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function focusRegion(region: RegisteredFocusRegion) {
  const target = region.getInitialFocus?.() ?? region.element;
  if (!target) {
    return;
  }

  if (!target.hasAttribute("tabindex") && target === region.element) {
    target.tabIndex = -1;
  }
  target.focus({ preventScroll: true });
  target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

function findActiveFocusRegion(
  regions: RegisteredFocusRegion[],
  activeRegionId: FocusRegionId | null,
): RegisteredFocusRegion | null {
  return (
    regions.find((region) => region.id === activeRegionId) ??
    regions.find((region) => region.element.contains(document.activeElement)) ??
    regions[0] ??
    null
  );
}

function findFocusRegionByKey(
  regions: RegisteredFocusRegion[],
  key: string,
): RegisteredFocusRegion | null {
  const normalizedKey = key.toLowerCase();
  return (
    regions.find((region) => region.key.toLowerCase() === normalizedKey) ?? null
  );
}

export function useFocusRegion(registration: FocusRegionRegistration): void {
  const context = useContext(FocusRegionContext);

  useEffect(() => {
    return context?.registerRegion(registration);
  }, [context, registration]);
}

export function FocusRegionProvider({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  const registrationsRef = useRef(
    new Map<FocusRegionId, FocusRegionRegistration>(),
  );
  const activeRegionIdRef = useRef<FocusRegionId | null>(null);
  const suppressedPaneJumpKeyRef = useRef<string | null>(null);
  const [visibleRegions, setVisibleRegions] = useState<RegisteredFocusRegion[]>(
    [],
  );
  const [paneJumpActive, setPaneJumpActive] = useState(false);
  const [paneJumpActivity, setPaneJumpActivity] = useState(0);
  // Resolved by the shortcut registry: user override → the pane-jump
  // experiment's configured shortcut → the built-in default.
  const paneJumpBindings = useShortcutBindings("navigation.paneJump");
  const paneJumpShortcut =
    paneJumpBindings[0]?.shortcut ?? DEFAULT_PANE_JUMP_SHORTCUT;

  const closePaneJump = useCallback(() => {
    activeRegionIdRef.current = null;
    setPaneJumpActive(false);
    setVisibleRegions([]);
  }, []);

  const refreshVisibleRegions = useCallback(() => {
    const nextRegions = getVisibleFocusRegions(
      registrationsRef.current.values(),
    );
    setVisibleRegions(nextRegions);
    if (
      activeRegionIdRef.current &&
      !nextRegions.some((region) => region.id === activeRegionIdRef.current)
    ) {
      closePaneJump();
    }
    return nextRegions;
  }, [closePaneJump]);

  const openPaneJump = useCallback(() => {
    if (!enabled) {
      return;
    }

    if (hasOpenKeyboardOwningLayer()) {
      return;
    }

    const nextRegions = refreshVisibleRegions();
    if (nextRegions.length === 0) {
      return;
    }

    setPaneJumpActive(true);
    setPaneJumpActivity((activity) => activity + 1);
  }, [enabled, refreshVisibleRegions]);

  const registerRegion = useCallback(
    (registration: FocusRegionRegistration) => {
      registrationsRef.current.set(registration.id, registration);
      if (paneJumpActive) {
        refreshVisibleRegions();
      }

      return () => {
        registrationsRef.current.delete(registration.id);
        if (activeRegionIdRef.current === registration.id) {
          closePaneJump();
          return;
        }
        if (paneJumpActive) {
          refreshVisibleRegions();
        }
      };
    },
    [closePaneJump, paneJumpActive, refreshVisibleRegions],
  );

  if (!enabled && paneJumpActive) {
    closePaneJump();
  }

  useEffect(() => {
    if (!enabled || !paneJumpActive) {
      return;
    }

    void paneJumpActivity;
    const timeoutId = window.setTimeout(closePaneJump, PANE_JUMP_TIMEOUT_MS);
    return () => window.clearTimeout(timeoutId);
  }, [closePaneJump, enabled, paneJumpActive, paneJumpActivity]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      // A shortcut-recording control (Settings → Keyboard shortcuts) owns
      // the keyboard entirely; don't intercept the prefix mid-recording.
      if (
        event.target instanceof Element &&
        event.target.closest('[data-shortcut-recording="true"]')
      ) {
        return;
      }
      const isPrefix = keyboardEventMatchesShortcut(event, paneJumpShortcut);
      const consumeKeyDown = () => {
        suppressedPaneJumpKeyRef.current = event.key;
        consumePaneJumpKey(event);
      };

      if (!paneJumpActive) {
        if (isPrefix) {
          consumeKeyDown();
          openPaneJump();
        }
        return;
      }

      if (event.key === "Escape" || isPrefix) {
        consumeKeyDown();
        closePaneJump();
        return;
      }

      setPaneJumpActivity((activity) => activity + 1);

      const regions = refreshVisibleRegions();
      const keyRegion = findFocusRegionByKey(regions, event.key);
      if (keyRegion) {
        consumeKeyDown();
        activeRegionIdRef.current = keyRegion.id;
        focusRegion(keyRegion);
        closePaneJump();
        return;
      }

      const direction = directionFromKey(event.key);
      if (direction) {
        consumeKeyDown();
        const activeRegion = findActiveFocusRegion(
          regions,
          activeRegionIdRef.current,
        );
        if (!activeRegion) {
          return;
        }

        const nextRegion = getNearestFocusRegion(
          activeRegion,
          regions,
          direction,
        );
        if (nextRegion) {
          activeRegionIdRef.current = nextRegion.id;
          focusRegion(nextRegion);
          closePaneJump();
        }
      }
    };
    const handleSuppressedKey = (event: KeyboardEvent) => {
      if (suppressedPaneJumpKeyRef.current !== event.key) {
        return;
      }

      consumePaneJumpKey(event);
      if (event.type === "keyup") {
        suppressedPaneJumpKeyRef.current = null;
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keypress", handleSuppressedKey, true);
    window.addEventListener("keyup", handleSuppressedKey, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keypress", handleSuppressedKey, true);
      window.removeEventListener("keyup", handleSuppressedKey, true);
    };
  }, [
    closePaneJump,
    enabled,
    openPaneJump,
    paneJumpActive,
    paneJumpShortcut,
    refreshVisibleRegions,
  ]);

  useEffect(() => {
    if (!enabled || !paneJumpActive) {
      return;
    }

    const handleResize = () => refreshVisibleRegions();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [enabled, paneJumpActive, refreshVisibleRegions]);

  const value = useMemo(() => ({ registerRegion }), [registerRegion]);

  return (
    <FocusRegionContext.Provider value={value}>
      {children}
      {enabled && paneJumpActive ? (
        <PaneJumpOverlay regions={visibleRegions} />
      ) : null}
    </FocusRegionContext.Provider>
  );
}
