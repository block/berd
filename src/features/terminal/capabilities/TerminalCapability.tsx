import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
} from "react";
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
  TERMINAL_DOCK_MIN_HEIGHT_PX,
  TERMINAL_FLOATING_COLLAPSED_HEIGHT_PX,
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
}

export function TerminalCapability({
  controller,
  rootRef,
  sessionId,
  getDockTargetForPointer,
  onDockPreviewChange,
}: TerminalCapabilityProps) {
  const { t } = useTranslation("chat");
  const floatingPanelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) {
        return;
      }

      if (eventMatchesShortcutCommand(event, "terminal.newTab")) {
        const target = event.target;
        const terminalHasFocus =
          target instanceof Node && Boolean(rootRef?.current?.contains(target));
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
      const sourceRect =
        rootRef?.current?.getBoundingClientRect() ??
        floatingPanelRef.current?.getBoundingClientRect() ??
        event.currentTarget.getBoundingClientRect();
      const startPlacement = controller.placement;
      let hasSeparated = false;
      let currentDockTarget: TerminalDockedPlacement | null = null;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const clientX = Number.isFinite(moveEvent.clientX)
          ? moveEvent.clientX
          : startX;
        const clientY = Number.isFinite(moveEvent.clientY)
          ? moveEvent.clientY
          : startY;
        const deltaX = clientX - startX;
        const deltaY = clientY - startY;
        const separated =
          Math.abs(deltaX) > TERMINAL_HEADER_DRAG_THRESHOLD_PX ||
          Math.abs(deltaY) > TERMINAL_HEADER_DRAG_THRESHOLD_PX;

        if (!hasSeparated && !separated) {
          return;
        }

        if (
          startPlacement.kind === "docked" &&
          deltaY >= -TERMINAL_HEADER_DRAG_THRESHOLD_PX
        ) {
          return;
        }

        hasSeparated = true;
        if (startPlacement.kind === "docked") {
          controller.popOutFromRect(sourceRect);
        }

        const dockTarget = getDockTargetForPointer?.(clientX, clientY) ?? null;
        currentDockTarget = dockTarget;
        onDockPreviewChange?.(dockTarget);

        const startRect =
          startPlacement.kind === "floating"
            ? startPlacement.rect
            : {
                x: sourceRect.left,
                y: sourceRect.top,
                width: sourceRect.width,
                height: sourceRect.height,
              };
        controller.updateFloatingRect({
          ...startRect,
          x: startRect.x + deltaX,
          y: startRect.y + deltaY,
        });
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
            ? (getDockTargetForPointer?.(upClientX, upClientY) ??
              currentDockTarget)
            : null;

        if (dropTarget) {
          controller.dockToRegion(dropTarget.region);
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
    [controller, getDockTargetForPointer, onDockPreviewChange, rootRef],
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
      const startX = Number.isFinite(event.clientX) ? event.clientX : 0;
      const startY = Number.isFinite(event.clientY) ? event.clientY : 0;
      const startRect = controller.placement.rect;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const clientX = Number.isFinite(moveEvent.clientX)
          ? moveEvent.clientX
          : startX;
        const clientY = Number.isFinite(moveEvent.clientY)
          ? moveEvent.clientY
          : startY;
        controller.updateFloatingRect(
          resolveFloatingTerminalResizeRect(
            startRect,
            edge,
            clientX - startX,
            clientY - startY,
          ),
        );
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", cleanup);
        window.removeEventListener("blur", cleanup);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = getResizeCursor(edge);
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", cleanup, { once: true });
      window.addEventListener("blur", cleanup);
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
      const startY = Number.isFinite(event.clientY) ? event.clientY : 0;
      const startHeight = controller.dockHeight;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const clientY = Number.isFinite(moveEvent.clientY)
          ? moveEvent.clientY
          : startY;
        const deltaY = clientY - startY;
        controller.updateDockHeight(
          edge === "bottom" ? startHeight + deltaY : startHeight - deltaY,
        );
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", cleanup);
        window.removeEventListener("blur", cleanup);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", cleanup, { once: true });
      window.addEventListener("blur", cleanup);
    },
    [controller],
  );

  const panel = (
    <TerminalPanelShell
      controller={controller}
      dockHeight={controller.dockHeight}
      floating={controller.placement.kind === "floating"}
      onDockResizeStart={startDockedResize}
      onHeaderPointerDown={startHeaderDrag}
      onTabKeyDown={handleTerminalTabKeyDown}
      sessionId={sessionId}
      t={t}
    />
  );

  if (controller.placement.kind === "floating") {
    return (
      <div
        ref={floatingPanelRef}
        className="fixed z-50 min-h-11 min-w-[320px] overflow-hidden rounded-md bg-card shadow-[var(--shadow-modal)] ring-1 ring-border/80"
        style={floatingRectStyle(
          controller.placement.rect,
          controller.expanded,
        )}
      >
        {panel}
        {controller.expanded ? (
          <FloatingResizeHandles onResizeStart={startFloatingResize} t={t} />
        ) : null}
      </div>
    );
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
    <button
      key={handle.edge}
      type="button"
      tabIndex={-1}
      aria-label={t("terminal.resize")}
      data-terminal-resize-edge={handle.edge}
      title={t("terminal.resize")}
      onPointerDown={(event) => onResizeStart(handle.edge, event)}
      className={cn(handleClassName, handle.className)}
    />
  ));
}

function TerminalPanelShell({
  controller,
  dockHeight,
  floating,
  onDockResizeStart,
  onHeaderPointerDown,
  onTabKeyDown,
  sessionId,
  t,
}: {
  controller: TerminalController;
  dockHeight: number;
  floating: boolean;
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
  const dockResizeEdge =
    controller.dockedPlacement.region === "rightRail" ? "bottom" : "top";

  return (
    <div
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
        "relative flex flex-col overflow-hidden rounded-md bg-card text-foreground transition-[height] duration-200 ease-out will-change-[height] motion-reduce:transition-none",
        floating ? "h-full shrink-0" : "min-h-11 shrink",
        !floating && !controller.expanded && "h-11",
      )}
      style={
        !floating && controller.expanded
          ? { height: dockHeight, minHeight: TERMINAL_DOCK_MIN_HEIGHT_PX }
          : undefined
      }
    >
      {!floating && controller.expanded ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={t("terminal.resize")}
          data-terminal-resize-edge={dockResizeEdge}
          title={t("terminal.resize")}
          onPointerDown={(event) => onDockResizeStart(dockResizeEdge, event)}
          className={cn(
            "absolute right-3 left-3 z-30 h-3 cursor-ns-resize bg-transparent outline-none",
            dockResizeEdge === "bottom"
              ? "bottom-0 translate-y-1/2"
              : "top-0 -translate-y-1/2",
          )}
        />
      ) : null}
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
                          variant="destructive"
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
                      collapsed={false}
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
