import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  IconChevronDown,
  IconChevronUp,
  IconExternalLink,
  IconLayoutBottombar,
  IconPlus,
  IconRotateClockwise,
  IconX,
} from "@tabler/icons-react";
import { Button } from "@/shared/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { cn } from "@/shared/lib/cn";
import { eventMatchesShortcutCommand } from "@/features/shortcuts/lib/shortcutRegistry";
import { TerminalPanel } from "@/features/terminal/ui/TerminalPanel";
import {
  terminalTabButtonId,
  terminalTabPanelId,
  resolveFloatingTerminalResizeRect,
  resolveTerminalDockHeight,
  TERMINAL_DOCK_HEADER_HEIGHT_PX,
  TERMINAL_DOCK_MIN_HEIGHT_PX,
  TERMINAL_FLOATING_COLLAPSED_HEIGHT_PX,
  TERMINAL_FLOATING_MIN_WIDTH_PX,
  type TerminalDockedPlacement,
  type TerminalFloatingRect,
  type TerminalResizeEdge,
  type TerminalTab,
} from "@/features/terminal/model/terminalState";
import type { TerminalController } from "@/features/terminal/hooks/useTerminalController";

const TERMINAL_HEADER_ICON_BUTTON_CLASS =
  "rounded-md text-muted-foreground opacity-70 hover:text-foreground hover:opacity-100 data-[state=open]:text-foreground data-[state=open]:opacity-100 aria-expanded:text-muted-foreground";
const TERMINAL_HEADER_DRAG_THRESHOLD_PX = 10;

function getResizeCursor(edge: TerminalResizeEdge): string {
  switch (edge) {
    case "top":
    case "bottom":
      return "row-resize";
    case "left":
    case "right":
      return "col-resize";
    case "top-left":
    case "bottom-right":
      return "nwse-resize";
    case "top-right":
    case "bottom-left":
      return "nesw-resize";
  }
}

interface TerminalCapabilityProps {
  controller: TerminalController;
  rootRef?: RefObject<HTMLDivElement | null>;
  sessionId: string;
  getDockTargetForPointer?: (
    clientX: number,
    clientY: number,
  ) => TerminalDockedPlacement | null;
  onDockPreviewChange?: (placement: TerminalDockedPlacement | null) => void;
  onDockToRegion?: (region: TerminalDockedPlacement["region"]) => void;
}

export function TerminalCapability({
  controller,
  rootRef,
  sessionId,
  getDockTargetForPointer,
  onDockPreviewChange,
  onDockToRegion,
}: TerminalCapabilityProps) {
  const { t } = useTranslation("chat");
  const floatingPanelRef = useRef<HTMLDivElement | null>(null);
  // Live overrides applied while a resize drag is in flight. Rendering reads
  // these instead of the persisted controller state so each pointer frame only
  // updates local component state — no per-frame localStorage write or
  // ChatView re-render. The final value is committed to the controller on
  // pointer release, after which the override is cleared.
  const [liveFloatingRect, setLiveFloatingRect] =
    useState<TerminalFloatingRect | null>(null);
  const [liveDockHeight, setLiveDockHeight] = useState<number | null>(null);
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) {
        return;
      }

      if (eventMatchesShortcutCommand(event, "terminal.newTab")) {
        const target = event.target;
        const terminalHasFocus =
          target instanceof Node &&
          (Boolean(rootRef?.current?.contains(target)) ||
            Boolean(floatingPanelRef.current?.contains(target)));
        if (!terminalHasFocus) {
          return;
        }

        event.preventDefault();
        controller.addTab();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [controller.addTab, rootRef]);

  const handleTerminalTabKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, tabId: string) => {
      const currentIndex = controller.tabs.findIndex((tab) => tab.id === tabId);
      if (currentIndex === -1) {
        return;
      }

      let nextTab: TerminalTab | null = null;
      switch (event.key) {
        case "ArrowRight":
          nextTab =
            controller.tabs[(currentIndex + 1) % controller.tabs.length];
          break;
        case "ArrowLeft":
          nextTab =
            controller.tabs[
              (currentIndex - 1 + controller.tabs.length) %
                controller.tabs.length
            ];
          break;
        case "Home":
          nextTab = controller.tabs[0] ?? null;
          break;
        case "End":
          nextTab = controller.tabs.at(-1) ?? null;
          break;
        default:
          return;
      }

      if (!nextTab) {
        return;
      }

      event.preventDefault();
      controller.selectTab(nextTab.id);
      window.requestAnimationFrame(() => {
        document.getElementById(terminalTabButtonId(nextTab.id))?.focus();
      });
    },
    [controller],
  );

  const startHeaderDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 && event.button !== undefined) {
        return;
      }

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest(
          "button, [role='tab'], [data-radix-popper-content-wrapper]",
        )
      ) {
        return;
      }

      event.preventDefault();
      const startX = Number.isFinite(event.clientX) ? event.clientX : 0;
      const startY = Number.isFinite(event.clientY) ? event.clientY : 0;
      const terminalShell = event.currentTarget.closest(
        "[data-terminal-shell]",
      );
      const sourceRect =
        (terminalShell instanceof HTMLElement
          ? terminalShell.getBoundingClientRect()
          : null) ??
        floatingPanelRef.current?.getBoundingClientRect() ??
        rootRef?.current?.getBoundingClientRect() ??
        event.currentTarget.getBoundingClientRect();
      const startPlacement = controller.placement;
      // Offset of the grab point inside the panel, so the panel stays rigidly
      // glued to the cursor at the exact spot it was picked up.
      const grabOffsetX = startX - sourceRect.left;
      const grabOffsetY = startY - sourceRect.top;
      // For an already-floating terminal, drive the drag rect from the stored
      // floating size, not the measured shell. A collapsed floating terminal
      // renders at the 44px collapsed height, so measuring it would write that
      // height back and clamp away the user's saved expanded height on the next
      // updateFloatingRect. Docked pop-out still uses the measured shell size.
      const panelWidth =
        startPlacement.kind === "floating"
          ? startPlacement.rect.width
          : sourceRect.width;
      const panelHeight =
        startPlacement.kind === "floating"
          ? startPlacement.rect.height
          : sourceRect.height;
      let hasSeparated = false;
      let hasLeftSourceDockRegion = startPlacement.kind !== "docked";
      let currentDockTarget: TerminalDockedPlacement | null = null;

      const resolveIntentionalDockTarget = (
        dockTarget: TerminalDockedPlacement | null,
      ): TerminalDockedPlacement | null => {
        if (startPlacement.kind !== "docked" || hasLeftSourceDockRegion) {
          return dockTarget;
        }

        if (dockTarget?.region === startPlacement.region) {
          return null;
        }

        hasLeftSourceDockRegion = true;
        return dockTarget;
      };

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const clientX = Number.isFinite(moveEvent.clientX)
          ? moveEvent.clientX
          : startX;
        const clientY = Number.isFinite(moveEvent.clientY)
          ? moveEvent.clientY
          : startY;
        const deltaX = clientX - startX;
        const deltaY = clientY - startY;

        // A small omnidirectional threshold separates an intentional drag from
        // a click. Any direction past the threshold pops the terminal out.
        if (
          !hasSeparated &&
          Math.abs(deltaX) <= TERMINAL_HEADER_DRAG_THRESHOLD_PX &&
          Math.abs(deltaY) <= TERMINAL_HEADER_DRAG_THRESHOLD_PX
        ) {
          return;
        }

        const nextDragRect = {
          x: clientX - grabOffsetX,
          y: clientY - grabOffsetY,
          width: panelWidth,
          height: panelHeight,
        };

        if (!hasSeparated && startPlacement.kind === "docked") {
          controller.popOutToRect(nextDragRect, "drag");
        } else {
          controller.updateFloatingRect(nextDragRect, "drag");
        }
        hasSeparated = true;

        const dockTarget = resolveIntentionalDockTarget(
          getDockTargetForPointer?.(clientX, clientY) ?? null,
        );
        currentDockTarget = dockTarget;
        onDockPreviewChange?.(dockTarget);
      };

      const cleanup = (upEvent?: PointerEvent) => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("blur", handleWindowBlur);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        onDockPreviewChange?.(null);

        const upClientX =
          upEvent && Number.isFinite(upEvent.clientX)
            ? upEvent.clientX
            : startX;
        const upClientY =
          upEvent && Number.isFinite(upEvent.clientY)
            ? upEvent.clientY
            : startY;
        const dropTarget =
          hasSeparated && upEvent
            ? (resolveIntentionalDockTarget(
                getDockTargetForPointer?.(upClientX, upClientY) ?? null,
              ) ?? currentDockTarget)
            : null;

        if (dropTarget) {
          controller.dockToRegion(dropTarget.region);
          onDockToRegion?.(dropTarget.region);
        } else if (hasSeparated) {
          // Settle the floating panel fully back inside the viewport margin
          // box now that the drag is over.
          controller.updateFloatingRect(
            {
              x: upClientX - grabOffsetX,
              y: upClientY - grabOffsetY,
              width: panelWidth,
              height: panelHeight,
            },
            "settle",
          );
        }
      };

      const handlePointerUp = (upEvent: PointerEvent) => cleanup(upEvent);
      const handleWindowBlur = () => cleanup();

      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp, { once: true });
      window.addEventListener("blur", handleWindowBlur);
    },
    [
      controller,
      getDockTargetForPointer,
      onDockPreviewChange,
      onDockToRegion,
      rootRef,
    ],
  );

  const startFloatingResize = useCallback(
    (edge: TerminalResizeEdge, event: ReactPointerEvent<HTMLElement>) => {
      if (
        controller.placement.kind !== "floating" ||
        (event.button !== 0 && event.button !== undefined)
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setIsResizing(true);
      const startX = Number.isFinite(event.clientX) ? event.clientX : 0;
      const startY = Number.isFinite(event.clientY) ? event.clientY : 0;
      const startRect = controller.placement.rect;
      let latestRect = startRect;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const clientX = Number.isFinite(moveEvent.clientX)
          ? moveEvent.clientX
          : startX;
        const clientY = Number.isFinite(moveEvent.clientY)
          ? moveEvent.clientY
          : startY;
        latestRect = resolveFloatingTerminalResizeRect(
          startRect,
          edge,
          clientX - startX,
          clientY - startY,
        );
        // Drive the drag from local state only; persist on release.
        setLiveFloatingRect(latestRect);
      };

      // `commit` persists the dragged size on a deliberate pointer release.
      // `discard` drops the live override without persisting so an interrupted
      // drag (e.g. window blur) snaps back to the pre-drag size.
      const teardown = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", commit);
        window.removeEventListener("blur", discard);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setLiveFloatingRect(null);
        setIsResizing(false);
      };
      const commit = () => {
        controller.updateFloatingRect(latestRect);
        teardown();
      };
      const discard = () => teardown();

      document.body.style.cursor = getResizeCursor(edge);
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", commit, { once: true });
      window.addEventListener("blur", discard);
    },
    [controller],
  );

  const startDockedResize = useCallback(
    (edge: "top" | "bottom", event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 && event.button !== undefined) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setIsResizing(true);
      const startY = Number.isFinite(event.clientY) ? event.clientY : 0;
      const startHeight = controller.dockHeight;
      let latestHeight = startHeight;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const clientY = Number.isFinite(moveEvent.clientY)
          ? moveEvent.clientY
          : startY;
        const deltaY = clientY - startY;
        latestHeight = resolveTerminalDockHeight(
          edge === "bottom" ? startHeight + deltaY : startHeight - deltaY,
        );
        // Drive the drag from local state only; persist on release.
        setLiveDockHeight(latestHeight);
      };

      // `commit` persists the dragged height on a deliberate pointer release.
      // `discard` drops the live override without persisting so an interrupted
      // drag (e.g. window blur) snaps back to the pre-drag height.
      const teardown = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", commit);
        window.removeEventListener("blur", discard);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setLiveDockHeight(null);
        setIsResizing(false);
      };
      const commit = () => {
        controller.updateDockHeight(latestHeight);
        teardown();
      };
      const discard = () => teardown();

      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", commit, { once: true });
      window.addEventListener("blur", discard);
    },
    [controller],
  );

  const panel = (
    <TerminalPanelShell
      controller={controller}
      dockHeight={liveDockHeight ?? controller.dockHeight}
      floating={controller.placement.kind === "floating"}
      resizing={isResizing}
      onDockResizeStart={startDockedResize}
      onHeaderPointerDown={startHeaderDrag}
      onTabKeyDown={handleTerminalTabKeyDown}
      sessionId={sessionId}
      t={t}
    />
  );

  if (controller.placement.kind === "floating") {
    const floatingPanel = (
      <div
        ref={floatingPanelRef}
        className="terminal-floating-shadow fixed z-50 min-h-11 overflow-hidden rounded-md border border-border/80 bg-card"
        style={floatingRectStyle(
          liveFloatingRect ?? controller.placement.rect,
          controller.expanded,
        )}
      >
        {panel}
        {controller.expanded ? (
          <FloatingResizeHandles onResizeStart={startFloatingResize} t={t} />
        ) : null}
      </div>
    );

    return typeof document === "undefined"
      ? floatingPanel
      : createPortal(floatingPanel, document.body);
  }

  return panel;
}

function floatingRectStyle(
  rect: TerminalFloatingRect,
  expanded: boolean,
): CSSProperties {
  return {
    left: rect.x,
    top: rect.y,
    width: rect.width,
    minWidth: TERMINAL_FLOATING_MIN_WIDTH_PX,
    height: expanded ? rect.height : TERMINAL_FLOATING_COLLAPSED_HEIGHT_PX,
  };
}

function FloatingResizeHandles({
  onResizeStart,
  t,
}: {
  onResizeStart: (
    edge: TerminalResizeEdge,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const handleClassName =
    "absolute z-20 touch-none bg-transparent outline-none";
  const handles: Array<{ edge: TerminalResizeEdge; className: string }> = [
    {
      edge: "top",
      className: "top-0 left-3 right-3 h-3 -translate-y-1/2 cursor-ns-resize",
    },
    {
      edge: "right",
      className: "top-3 right-0 bottom-3 w-3 translate-x-1/2 cursor-ew-resize",
    },
    {
      edge: "bottom",
      className: "right-3 bottom-0 left-3 h-3 translate-y-1/2 cursor-ns-resize",
    },
    {
      edge: "left",
      className: "top-3 bottom-3 left-0 w-3 -translate-x-1/2 cursor-ew-resize",
    },
    {
      edge: "top-left",
      className:
        "top-0 left-0 size-5 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize",
    },
    {
      edge: "top-right",
      className:
        "top-0 right-0 size-5 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize",
    },
    {
      edge: "bottom-right",
      className:
        "right-0 bottom-0 size-5 translate-x-1/2 translate-y-1/2 cursor-nwse-resize",
    },
    {
      edge: "bottom-left",
      className:
        "bottom-0 left-0 size-5 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize",
    },
  ];

  return handles.map((handle) => (
    <Tooltip key={handle.edge}>
      <TooltipTrigger asChild>
        <button
          type="button"
          tabIndex={-1}
          aria-label={t("terminal.resize")}
          data-terminal-resize-edge={handle.edge}
          onPointerDown={(event) => onResizeStart(handle.edge, event)}
          className={cn(handleClassName, handle.className)}
        />
      </TooltipTrigger>
      <TooltipContent>{t("terminal.resize")}</TooltipContent>
    </Tooltip>
  ));
}

function TerminalPanelShell({
  controller,
  dockHeight,
  floating,
  resizing,
  onDockResizeStart,
  onHeaderPointerDown,
  onTabKeyDown,
  sessionId,
  t,
}: {
  controller: TerminalController;
  dockHeight: number;
  floating: boolean;
  resizing: boolean;
  onDockResizeStart: (
    edge: "top" | "bottom",
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  onHeaderPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onTabKeyDown: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    tabId: string,
  ) => void;
  sessionId: string;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const dockResizeEdges: Array<"top" | "bottom"> =
    controller.dockedPlacement.region === "rightRail"
      ? ["top", "bottom"]
      : ["top"];

  // On first mount the docked shell is already expanded, so the height
  // transition never has a starting frame to animate from and the terminal
  // pops in at full height. Render one collapsed frame, then flip to the real
  // height so the transition grows the shell from the bottom up, pushing the
  // conversation smoothly instead of snapping it.
  const [hasEnteredHeight, setHasEnteredHeight] = useState(floating);
  useEffect(() => {
    if (floating) {
      setHasEnteredHeight(true);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      setHasEnteredHeight(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [floating]);

  const dockEntering = !floating && controller.expanded && !hasEnteredHeight;

  return (
    <div
      data-terminal-shell
      ref={
        controller.expanded ? controller.setTerminalRegionElement : undefined
      }
      onTransitionEnd={(event) => {
        if (
          event.target !== event.currentTarget ||
          event.propertyName !== "height"
        ) {
          return;
        }

        const terminalElement = event.currentTarget.querySelector(
          "[data-terminal-panel]",
        );
        terminalElement?.dispatchEvent(
          new CustomEvent("goose-terminal-shell-transition-end", {
            bubbles: true,
          }),
        );
      }}
      className={cn(
        "relative flex flex-col overflow-hidden rounded-md bg-card text-foreground will-change-[height]",
        resizing
          ? "transition-none"
          : "transition-[height] duration-200 ease-out motion-reduce:transition-none",
        floating ? "h-full shrink-0" : "min-h-11 shrink",
        !floating && !controller.expanded && "h-11",
      )}
      style={
        !floating && controller.expanded
          ? {
              // Grow from the collapsed header height up to the dock height on
              // the first mounted frame so the shell animates open from the
              // bottom rather than popping in at full height.
              height: dockEntering
                ? TERMINAL_DOCK_HEADER_HEIGHT_PX
                : dockHeight,
              minHeight: dockEntering
                ? TERMINAL_DOCK_HEADER_HEIGHT_PX
                : TERMINAL_DOCK_MIN_HEIGHT_PX,
            }
          : undefined
      }
    >
      {!floating && controller.expanded
        ? dockResizeEdges.map((edge) => (
            <Tooltip key={edge}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={t("terminal.resize")}
                  data-terminal-resize-edge={edge}
                  onPointerDown={(event) => onDockResizeStart(edge, event)}
                  className={cn(
                    "absolute right-3 left-3 z-30 h-3 cursor-ns-resize bg-transparent outline-none",
                    edge === "bottom"
                      ? "bottom-0 translate-y-1/2"
                      : "top-0 -translate-y-1/2",
                  )}
                />
              </TooltipTrigger>
              <TooltipContent>{t("terminal.resize")}</TooltipContent>
            </Tooltip>
          ))
        : null}
      <div
        role="toolbar"
        aria-label={t("terminal.title")}
        onPointerDown={onHeaderPointerDown}
        className={cn(
          "flex h-11 shrink-0 cursor-grab items-center gap-1 px-2 active:cursor-grabbing",
          controller.expanded && "border-b border-border/80",
        )}
      >
        <div
          role="tablist"
          aria-label={t("terminal.tabs")}
          className="scrollbar-none flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
          {controller.tabs.map((tab) => {
            const label = controller.getTabLabel(tab);
            const selected = tab.id === controller.activeTab?.id;
            const stopAndCloseLabel = t("terminal.stopAndCloseTab", {
              path: label,
            });
            const confirmStopTitle = t("terminal.confirmStopTabTitle", {
              path: label,
            });
            return (
              <div
                key={tab.id}
                className={cn(
                  "group flex h-8 min-w-0 max-w-48 shrink-0 items-center rounded-sm border border-transparent",
                  selected
                    ? "[background:color-mix(in_srgb,var(--foreground)_8%,var(--card))] text-foreground"
                    : "text-muted-foreground hover:[background:color-mix(in_srgb,var(--foreground)_5%,var(--card))] hover:text-foreground",
                )}
              >
                <button
                  id={terminalTabButtonId(tab.id)}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={terminalTabPanelId(tab.id)}
                  aria-label={t("terminal.selectTab", {
                    path: label,
                  })}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => controller.selectTab(tab.id)}
                  onKeyDown={(event) => onTabKeyDown(event, tab.id)}
                  className="flex h-full min-w-0 flex-1 items-center truncate px-2 text-left font-mono text-[11px] leading-none outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {label}
                </button>
                <Popover
                  open={controller.closingTabId === tab.id}
                  onOpenChange={(open) =>
                    controller.setClosingTabId(open ? tab.id : null)
                  }
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={stopAndCloseLabel}
                          className={cn(
                            "mr-0.5 size-6",
                            TERMINAL_HEADER_ICON_BUTTON_CLASS,
                          )}
                        >
                          <IconX className="size-4" />
                        </Button>
                      </PopoverTrigger>
                    </TooltipTrigger>
                    <TooltipContent>{stopAndCloseLabel}</TooltipContent>
                  </Tooltip>
                  <PopoverContent
                    side="top"
                    align="end"
                    sideOffset={8}
                    className="w-64 rounded-md p-3 text-left"
                  >
                    <div className="space-y-3">
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-foreground">
                          {confirmStopTitle}
                        </p>
                        <p className="text-xs leading-5 text-muted-foreground">
                          {t("terminal.confirmStopDescription")}
                        </p>
                      </div>
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => controller.setClosingTabId(null)}
                        >
                          {t("common:actions.cancel")}
                        </Button>
                        <Button
                          type="button"
                          variant="primary"
                          destructive
                          size="xs"
                          onClick={() => controller.closeTab(tab.id)}
                        >
                          {t("terminal.stop")}
                        </Button>
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            );
          })}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={controller.restart}
              disabled={!controller.activeTab}
              aria-label={t("terminal.restart")}
              className={TERMINAL_HEADER_ICON_BUTTON_CLASS}
            >
              <IconRotateClockwise className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("terminal.restart")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={controller.addTab}
              disabled={!controller.cwd}
              aria-label={t("terminal.newTab")}
              className={TERMINAL_HEADER_ICON_BUTTON_CLASS}
            >
              <IconPlus className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("terminal.newTab")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={floating ? controller.dockToBottom : controller.popOut}
              aria-label={
                floating ? t("terminal.dockToBottom") : t("terminal.popOut")
              }
              className={TERMINAL_HEADER_ICON_BUTTON_CLASS}
            >
              {floating ? (
                <IconLayoutBottombar className="size-4" />
              ) : (
                <IconExternalLink className="size-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {floating ? t("terminal.dockToBottom") : t("terminal.popOut")}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={
                controller.expanded ? controller.collapse : controller.expand
              }
              aria-expanded={controller.expanded}
              aria-label={
                controller.expanded
                  ? t("terminal.collapse")
                  : t("terminal.expand")
              }
              className={TERMINAL_HEADER_ICON_BUTTON_CLASS}
            >
              {controller.expanded ? (
                <IconChevronDown className="size-4" />
              ) : (
                <IconChevronUp className="size-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {controller.expanded
              ? t("terminal.collapse")
              : t("terminal.expand")}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className={cn("min-h-0 flex-1", !controller.expanded && "hidden")}>
        {controller.expanded
          ? controller.tabs.map((tab) => {
              const selected = tab.id === controller.activeTab?.id;
              return (
                <div
                  key={tab.id}
                  id={terminalTabPanelId(tab.id)}
                  role="tabpanel"
                  aria-labelledby={terminalTabButtonId(tab.id)}
                  tabIndex={selected ? 0 : undefined}
                  hidden={!selected}
                  className="h-full min-h-0"
                >
                  {selected ? (
                    <TerminalPanel
                      key={tab.id}
                      sessionKey={`${sessionId}:${tab.id}`}
                      cwd={tab.cwd}
                      // Treat the first entering frame as collapsed so xterm
                      // defers fitting until the 44px-to-dockHeight open
                      // transition ends, instead of fitting to intermediate
                      // tiny heights and sending bad row counts to the pty.
                      // This reuses TerminalPanel's collapse->expand defer path.
                      collapsed={dockEntering}
                      showHeader={false}
                      focusRequest={controller.focusRequest}
                      className="h-full bg-card"
                    />
                  ) : null}
                </div>
              );
            })
          : null}
      </div>
    </div>
  );
}
