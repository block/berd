import {
  isSamePath,
  toComparablePath,
  toIdentityKey,
} from "@/shared/lib/pathIdentity";

export interface TerminalTab {
  id: string;
  cwd: string;
}

export type TerminalDockedPlacement =
  | {
      kind: "docked";
      region: "chatColumn";
      slot: "bottom";
      size: TerminalDockSize;
    }
  | {
      kind: "docked";
      region: "rightRail";
      slot: "belowContext";
      size: TerminalDockSize;
    };

export type TerminalDockRegion = TerminalDockedPlacement["region"];
export type TerminalDockSlot = TerminalDockedPlacement["slot"];

export interface TerminalDockSize {
  height: number;
}

export type TerminalPlacement =
  | TerminalDockedPlacement
  | {
      kind: "floating";
      rect: TerminalFloatingRect;
      lastDockedPlacement?: TerminalDockedPlacement;
    };

export type TerminalResizeEdge =
  | "top"
  | "right"
  | "bottom"
  | "left"
  | "top-left"
  | "top-right"
  | "bottom-right"
  | "bottom-left";

export interface TerminalFloatingRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TerminalFloatingLimits {
  minX: number;
  minY: number;
  maxRight: number;
  maxBottom: number;
  maxWidth: number;
  maxHeight: number;
}

export interface TerminalState {
  tabs: TerminalTab[];
  activeTabId: string | null;
  expanded: boolean;
  placement: TerminalPlacement;
}

export const TERMINAL_STORAGE_KEY_PREFIX = "goose:chat-terminal-workspaces";

export const TERMINAL_FLOATING_MARGIN_PX = 16;
export const TERMINAL_FLOATING_DEFAULT_WIDTH_PX = 720;
export const TERMINAL_FLOATING_DEFAULT_HEIGHT_PX = 360;
export const TERMINAL_FLOATING_MIN_WIDTH_PX = 280;
export const TERMINAL_FLOATING_MIN_HEIGHT_PX = 220;
export const TERMINAL_FLOATING_COLLAPSED_HEIGHT_PX = 44;
export const TERMINAL_DOCK_DROP_ZONE_HEIGHT_PX = 140;
export const TERMINAL_DOCK_DEFAULT_HEIGHT_PX = 300;
export const TERMINAL_DOCK_MIN_HEIGHT_PX = 120;
// Height of the docked terminal header row (`h-11`). The shell collapses to
// this height, and the first-mount open animation grows from it.
export const TERMINAL_DOCK_HEADER_HEIGHT_PX = 44;
export const TERMINAL_DOCK_MAX_HEIGHT_PX = 560;

export function getDefaultTerminalDockedPlacement(
  region: TerminalDockRegion = "chatColumn",
): TerminalDockedPlacement {
  return region === "rightRail"
    ? {
        kind: "docked",
        region: "rightRail",
        slot: "belowContext",
        size: { height: TERMINAL_DOCK_DEFAULT_HEIGHT_PX },
      }
    : {
        kind: "docked",
        region: "chatColumn",
        slot: "bottom",
        size: { height: TERMINAL_DOCK_DEFAULT_HEIGHT_PX },
      };
}

export const DEFAULT_TERMINAL_PLACEMENT: TerminalDockedPlacement =
  getDefaultTerminalDockedPlacement("chatColumn");

export const DEFAULT_TERMINAL_STATE: TerminalState = {
  tabs: [],
  activeTabId: null,
  expanded: false,
  placement: DEFAULT_TERMINAL_PLACEMENT,
};

let terminalTabIdSequence = 0;

function clampValue(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function parseFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hashTerminalTabPath(path: string): string {
  let hash = 0;
  for (let index = 0; index < path.length; index += 1) {
    hash = (hash * 31 + path.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

export function createLegacyTerminalTabId(cwd: string, index: number): string {
  return `legacy-${index}-${hashTerminalTabPath(cwd)}`;
}

function createTerminalTabId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `tab-${crypto.randomUUID()}`;
  }

  terminalTabIdSequence += 1;
  return `tab-${Date.now().toString(36)}-${terminalTabIdSequence.toString(36)}`;
}

export function createTerminalTab(cwd: string): TerminalTab {
  return {
    id: createTerminalTabId(),
    cwd,
  };
}

export function appendActiveTerminalTab(
  state: TerminalState,
  tab: TerminalTab,
): TerminalState {
  return {
    ...state,
    tabs: [...state.tabs, tab],
    activeTabId: tab.id,
    expanded: true,
  };
}

export function removeTerminalTab(
  state: TerminalState,
  tabId: string,
): TerminalState {
  const closedIndex = state.tabs.findIndex((tab) => tab.id === tabId);
  if (closedIndex === -1) {
    return state;
  }

  const tabs = state.tabs.filter((tab) => tab.id !== tabId);
  if (tabs.length === 0) {
    return DEFAULT_TERMINAL_STATE;
  }

  const activeTabStillOpen = tabs.some((tab) => tab.id === state.activeTabId);
  const nearestTab = tabs[Math.min(closedIndex, tabs.length - 1)];
  return {
    ...state,
    tabs,
    activeTabId: activeTabStillOpen ? state.activeTabId : nearestTab.id,
  };
}

export function normalizeTerminalTabs(tabs: unknown[]): TerminalTab[] {
  const seenIds = new Set<string>();

  return tabs.reduce<TerminalTab[]>((normalizedTabs, item, index) => {
    if (!item || typeof item !== "object") {
      return normalizedTabs;
    }

    const tab = item as Partial<TerminalTab>;
    if (typeof tab.cwd !== "string" || tab.cwd.length === 0) {
      return normalizedTabs;
    }

    const baseId =
      typeof tab.id === "string" && tab.id.length > 0
        ? tab.id
        : createLegacyTerminalTabId(tab.cwd, index);
    let id = baseId;
    let duplicateIndex = 1;
    while (seenIds.has(id)) {
      duplicateIndex += 1;
      id = `${baseId}-${duplicateIndex}`;
    }

    seenIds.add(id);
    normalizedTabs.push({ id, cwd: tab.cwd });
    return normalizedTabs;
  }, []);
}

export function findDefaultTerminalTab(
  tabs: TerminalTab[],
  cwd: string | null,
): TerminalTab | null {
  if (!cwd) {
    return null;
  }

  return tabs.find((tab) => isSamePath(tab.cwd, cwd)) ?? null;
}

export function shortenTerminalPath(path: string): string {
  const normalized = toComparablePath(path);
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length <= 2) {
    return normalized || path;
  }

  return `~/${segments.slice(-2).join("/")}`;
}

export function terminalTabLabel(
  tab: TerminalTab,
  tabs: TerminalTab[],
): string {
  const baseLabel = shortenTerminalPath(tab.cwd);
  const matchingTabs = tabs.filter((candidate) =>
    isSamePath(candidate.cwd, tab.cwd),
  );
  if (matchingTabs.length <= 1) {
    return baseLabel;
  }

  const duplicateIndex =
    matchingTabs.findIndex((candidate) => candidate.id === tab.id) + 1;
  return `${baseLabel} (${duplicateIndex})`;
}

export function terminalTabButtonId(tabId: string): string {
  return `terminal-tab-${tabId}`;
}

export function terminalTabPanelId(tabId: string): string {
  return `terminal-tabpanel-${tabId}`;
}

function normalizeFloatingTerminalRect(
  value: unknown,
): TerminalFloatingRect | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const parsed = value as Partial<TerminalFloatingRect> & {
    left?: unknown;
    top?: unknown;
  };
  const x = parseFiniteNumber(parsed.x) ?? parseFiniteNumber(parsed.left);
  const y = parseFiniteNumber(parsed.y) ?? parseFiniteNumber(parsed.top);
  const width = parseFiniteNumber(parsed.width);
  const height = parseFiniteNumber(parsed.height);

  if (x === null || y === null || width === null || height === null) {
    return null;
  }

  return { x, y, width, height };
}

function getFloatingTerminalLimits(): TerminalFloatingLimits {
  const viewportWidth =
    typeof window === "undefined" ? 1280 : Math.max(window.innerWidth, 1);
  const viewportHeight =
    typeof window === "undefined" ? 800 : Math.max(window.innerHeight, 1);
  const minX = TERMINAL_FLOATING_MARGIN_PX;
  const minY = TERMINAL_FLOATING_MARGIN_PX;
  const maxRight = viewportWidth - TERMINAL_FLOATING_MARGIN_PX;
  const maxBottom = viewportHeight - TERMINAL_FLOATING_MARGIN_PX;
  const maxWidth = Math.max(TERMINAL_FLOATING_MIN_WIDTH_PX, maxRight - minX);
  const maxHeight = Math.max(TERMINAL_FLOATING_MIN_HEIGHT_PX, maxBottom - minY);

  return { minX, minY, maxRight, maxBottom, maxWidth, maxHeight };
}

export function resolveTerminalDockHeight(height: unknown): number {
  const parsedHeight =
    parseFiniteNumber(height) ?? TERMINAL_DOCK_DEFAULT_HEIGHT_PX;
  const viewportMaxHeight =
    typeof window === "undefined"
      ? TERMINAL_DOCK_MAX_HEIGHT_PX
      : Math.max(
          TERMINAL_DOCK_MIN_HEIGHT_PX,
          Math.min(TERMINAL_DOCK_MAX_HEIGHT_PX, window.innerHeight * 0.65),
        );

  return clampValue(
    parsedHeight,
    TERMINAL_DOCK_MIN_HEIGHT_PX,
    viewportMaxHeight,
  );
}

export function resolveTerminalDockedPlacement(
  value?: Partial<TerminalDockedPlacement> | null,
): TerminalDockedPlacement {
  const size = (
    value as { size?: Partial<TerminalDockSize> } | null | undefined
  )?.size;
  const region = value?.region === "rightRail" ? "rightRail" : "chatColumn";
  const placement = getDefaultTerminalDockedPlacement(region);

  return {
    ...placement,
    size: { height: resolveTerminalDockHeight(size?.height) },
  };
}

/**
 * Bounds mode for a floating terminal rect.
 *
 * - `"settle"` keeps the panel fully inside the viewport margin box. Used for
 *   the resting position (initial pop-out, drop, persistence, resize).
 * - `"drag"` lets the panel follow the cursor freely while a drag is in
 *   flight, enforcing only that a grabbable strip of the header stays
 *   on-screen so the panel can never be lost off the edge.
 */
export type TerminalFloatingBoundsMode = "settle" | "drag";

// While dragging, keep at least this much of the panel reachable on each axis
// so the header can always be grabbed again. Reuses existing layout constants
// rather than introducing new magic numbers.
const TERMINAL_FLOATING_DRAG_GRABBABLE_PX = TERMINAL_FLOATING_MARGIN_PX * 4;

export function resolveFloatingTerminalRect(
  rect: TerminalFloatingRect | null,
  mode: TerminalFloatingBoundsMode = "settle",
): TerminalFloatingRect {
  const { minX, minY, maxRight, maxBottom, maxWidth, maxHeight } =
    getFloatingTerminalLimits();
  const width = clampValue(
    rect?.width ?? Math.min(TERMINAL_FLOATING_DEFAULT_WIDTH_PX, maxWidth),
    TERMINAL_FLOATING_MIN_WIDTH_PX,
    maxWidth,
  );
  const height = clampValue(
    rect?.height ?? Math.min(TERMINAL_FLOATING_DEFAULT_HEIGHT_PX, maxHeight),
    TERMINAL_FLOATING_MIN_HEIGHT_PX,
    maxHeight,
  );
  const defaultX = maxRight - width;
  const defaultY = maxBottom - height - TERMINAL_FLOATING_MARGIN_PX * 2;

  // "settle" pins the panel fully inside the margin box. "drag" only requires
  // that a grabbable strip stays on-screen, so the panel stays glued to the
  // cursor and can overhang the edges mid-drag.
  let minXBound: number;
  let maxXBound: number;
  let minYBound: number;
  let maxYBound: number;
  if (mode === "drag") {
    const grab = TERMINAL_FLOATING_DRAG_GRABBABLE_PX;
    minXBound = TERMINAL_FLOATING_MARGIN_PX + grab - width;
    maxXBound = maxRight - grab;
    minYBound = minY;
    maxYBound = maxBottom - grab;
  } else {
    minXBound = minX;
    maxXBound = maxRight - width;
    minYBound = minY;
    maxYBound = maxBottom - height;
  }

  return {
    x: clampValue(rect?.x ?? defaultX, minXBound, maxXBound),
    y: clampValue(rect?.y ?? defaultY, minYBound, maxYBound),
    width,
    height,
  };
}

export function resolveFloatingTerminalResizeRect(
  startRect: TerminalFloatingRect,
  edge: TerminalResizeEdge,
  deltaX: number,
  deltaY: number,
): TerminalFloatingRect {
  const { minX, minY, maxRight, maxBottom, maxWidth, maxHeight } =
    getFloatingTerminalLimits();
  const nextRect = { ...startRect };

  if (edge.includes("left")) {
    const actualDeltaX = clampValue(
      deltaX,
      Math.max(minX - startRect.x, startRect.width - maxWidth),
      startRect.width - TERMINAL_FLOATING_MIN_WIDTH_PX,
    );
    nextRect.x = startRect.x + actualDeltaX;
    nextRect.width = startRect.width - actualDeltaX;
  }

  if (edge.includes("right")) {
    nextRect.width = clampValue(
      startRect.width + deltaX,
      TERMINAL_FLOATING_MIN_WIDTH_PX,
      Math.max(TERMINAL_FLOATING_MIN_WIDTH_PX, maxRight - startRect.x),
    );
  }

  if (edge.includes("top")) {
    const actualDeltaY = clampValue(
      deltaY,
      Math.max(minY - startRect.y, startRect.height - maxHeight),
      startRect.height - TERMINAL_FLOATING_MIN_HEIGHT_PX,
    );
    nextRect.y = startRect.y + actualDeltaY;
    nextRect.height = startRect.height - actualDeltaY;
  }

  if (edge.includes("bottom")) {
    nextRect.height = clampValue(
      startRect.height + deltaY,
      TERMINAL_FLOATING_MIN_HEIGHT_PX,
      Math.max(TERMINAL_FLOATING_MIN_HEIGHT_PX, maxBottom - startRect.y),
    );
  }

  return nextRect;
}

export function getDefaultFloatingTerminalRect(): TerminalFloatingRect {
  return resolveFloatingTerminalRect(null);
}

export function isTerminalDockDropZone(clientY: number): boolean {
  const viewportHeight =
    typeof window === "undefined" ? 800 : Math.max(window.innerHeight, 1);
  return clientY >= viewportHeight - TERMINAL_DOCK_DROP_ZONE_HEIGHT_PX;
}

function validateTerminalPlacement(value: unknown): TerminalPlacement {
  if (!value || typeof value !== "object") {
    return DEFAULT_TERMINAL_PLACEMENT;
  }

  const placement = value as Partial<TerminalPlacement> & {
    floatingBounds?: unknown;
  };
  if (placement.kind === "floating") {
    return {
      kind: "floating",
      rect: resolveFloatingTerminalRect(
        normalizeFloatingTerminalRect(
          (placement as { rect?: unknown }).rect ?? placement.floatingBounds,
        ),
      ),
      lastDockedPlacement: resolveTerminalDockedPlacement(
        (placement as { lastDockedPlacement?: unknown }).lastDockedPlacement as
          | Partial<TerminalDockedPlacement>
          | undefined,
      ),
    };
  }

  if (placement.kind === "docked") {
    return resolveTerminalDockedPlacement(placement);
  }

  // Legacy placement shape from the first bottom-dock terminal implementation.
  if ((placement as { kind?: unknown }).kind === "bottomDock") {
    return DEFAULT_TERMINAL_PLACEMENT;
  }

  return DEFAULT_TERMINAL_PLACEMENT;
}

export function validateTerminalState(
  value: unknown,
  defaults: TerminalState,
): TerminalState {
  if (!value || typeof value !== "object") {
    return defaults;
  }

  const parsed = value as Partial<TerminalState> & {
    floatingBounds?: unknown;
  };
  if (Array.isArray(parsed.tabs)) {
    const tabs = normalizeTerminalTabs(parsed.tabs);
    const activeTabId =
      typeof parsed.activeTabId === "string" &&
      tabs.some((tab) => tab.id === parsed.activeTabId)
        ? parsed.activeTabId
        : (tabs[0]?.id ?? null);
    const rawPlacement = (parsed as { placement?: unknown }).placement;
    const placementInput =
      rawPlacement === "floating"
        ? { kind: "floating", floatingBounds: parsed.floatingBounds }
        : rawPlacement;
    const placement =
      tabs.length > 0
        ? validateTerminalPlacement(placementInput)
        : DEFAULT_TERMINAL_PLACEMENT;

    return {
      tabs,
      activeTabId,
      expanded: tabs.length > 0 && parsed.expanded === true,
      placement,
    };
  }

  const legacyParsed = value as {
    paths?: unknown;
    expandedPath?: unknown;
  };
  const legacyPaths = Array.isArray(legacyParsed.paths)
    ? legacyParsed.paths.filter(
        (path): path is string => typeof path === "string" && path.length > 0,
      )
    : [];
  const uniquePathsByKey = new Map<string, string>();
  for (const path of legacyPaths) {
    const key = toIdentityKey(path);
    if (!uniquePathsByKey.has(key)) {
      uniquePathsByKey.set(key, path);
    }
  }
  const uniquePaths = [...uniquePathsByKey.values()];
  const tabs = uniquePaths.map((cwd, index) => ({
    id: createLegacyTerminalTabId(cwd, index),
    cwd,
  }));
  const expandedPath =
    typeof legacyParsed.expandedPath === "string"
      ? legacyParsed.expandedPath
      : null;
  const activeTab = expandedPath
    ? (tabs.find((tab) => isSamePath(tab.cwd, expandedPath)) ?? null)
    : null;

  return {
    tabs,
    activeTabId: activeTab?.id ?? tabs[0]?.id ?? defaults.activeTabId,
    expanded: Boolean(activeTab),
    placement: DEFAULT_TERMINAL_PLACEMENT,
  };
}
