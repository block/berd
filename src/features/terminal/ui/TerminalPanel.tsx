import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import type { ITheme } from "@xterm/xterm";
import {
  IconChevronDown,
  IconChevronUp,
  IconRotateClockwise,
  IconX,
} from "@tabler/icons-react";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { cn } from "@/shared/lib/cn";
import { perfLog } from "@/shared/lib/perfLog";
import { scheduleAfterNextPaint } from "@/app/lib/scheduleAfterNextPaint";
import { useTheme } from "@/shared/theme/ThemeProvider";
import {
  getTerminalSessionStatus,
  getOrCreateTerminalSession,
  subscribeTerminalSessionStatus,
  type TerminalSession,
  type TerminalSessionLabels,
  type TerminalStatus,
} from "../lib/terminalSessionManager";

const TERMINAL_EXPAND_RESIZE_FALLBACK_MS = 260;

function shortTerminalSessionKey(sessionKey: string): string {
  const [sessionId, tabId] = sessionKey.split(":");
  return `${sessionId?.slice(0, 8) ?? "unknown"}:${tabId ?? "unknown"}`;
}

interface TerminalPanelProps {
  sessionKey: string;
  cwd: string;
  collapsed?: boolean;
  showHeader?: boolean;
  className?: string;
  onCollapse?: () => void;
  onExpand?: () => void;
  onClose?: () => void;
  /**
   * Monotonic counter bumped by the parent each time a user action opens or
   * brings the terminal forward. A change moves focus into the terminal.
   * Starts at 0, which is treated as "no user request yet" so restoring an
   * already-open terminal on reload does not steal focus.
   */
  focusRequest?: number;
}

function shortenPath(path: string): string {
  const home = typeof window === "undefined" ? "" : "~";
  const normalized = path.replace(/\/+$/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length <= 2) {
    return normalized || path;
  }

  return `${home}/${segments.slice(-2).join("/")}`;
}

function readToken(
  styles: CSSStyleDeclaration,
  name: string,
  fallback: string,
): string {
  return styles.getPropertyValue(name).trim() || fallback;
}

function resolveCssColor(value: string, property: "backgroundColor" | "color") {
  if (typeof document === "undefined") {
    return value;
  }

  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.inset = "0 auto auto -9999px";
  probe.style.pointerEvents = "none";
  probe.style.visibility = "hidden";
  probe.style[property] = value;

  const parent = document.body ?? document.documentElement;
  parent.appendChild(probe);
  const resolved = window.getComputedStyle(probe)[property].trim();
  probe.remove();

  return resolved || value;
}

function readColorToken(
  styles: CSSStyleDeclaration,
  name: string,
  fallback: string,
  property: "backgroundColor" | "color" = "color",
): string {
  return resolveCssColor(readToken(styles, name, fallback), property);
}

function withAlpha(color: string, alpha: number): string {
  const match = color.match(
    /rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/,
  );

  if (!match) {
    return color;
  }

  const [, red, green, blue] = match;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function readPercentageToken(
  styles: CSSStyleDeclaration,
  name: string,
  fallback: number,
): number {
  const value = readToken(styles, name, `${fallback * 100}%`);
  const parsed = Number.parseFloat(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return value.endsWith("%") ? parsed / 100 : parsed;
}

function resolveTerminalTheme(resolvedTheme: "dark" | "light"): ITheme {
  if (typeof window === "undefined") {
    return {};
  }

  const defaultForeground = resolvedTheme === "dark" ? "#ffffff" : "#242424";
  const defaultBackground = resolvedTheme === "dark" ? "#232323" : "#ffffff";
  const defaultPrimary = resolvedTheme === "dark" ? "#ffffff" : "#242424";
  const styles = window.getComputedStyle(document.documentElement);
  const foreground = readColorToken(styles, "--foreground", defaultForeground);
  const background = readColorToken(
    styles,
    "--card",
    defaultBackground,
    "backgroundColor",
  );
  const primary = readColorToken(styles, "--primary", defaultPrimary);
  const mutedForeground = readColorToken(
    styles,
    "--muted-foreground",
    "var(--muted-foreground)",
  );
  const red = readColorToken(styles, "--destructive", "var(--destructive)");
  const green = readColorToken(styles, "--success", "var(--success)");
  const yellow = readColorToken(styles, "--warning", "var(--warning)");
  const blue = readColorToken(styles, "--info", "var(--info)");
  const scrollbarAlpha = readPercentageToken(
    styles,
    "--scrollbar-thumb-alpha",
    resolvedTheme === "dark" ? 0.16 : 0.14,
  );
  const scrollbarHoverAlpha = readPercentageToken(
    styles,
    "--scrollbar-thumb-hover-alpha",
    resolvedTheme === "dark" ? 0.26 : 0.22,
  );

  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: withAlpha(
      primary,
      resolvedTheme === "dark" ? 0.3 : 0.18,
    ),
    selectionForeground: foreground,
    selectionInactiveBackground: withAlpha(
      primary,
      resolvedTheme === "dark" ? 0.18 : 0.12,
    ),
    scrollbarSliderBackground: withAlpha(foreground, scrollbarAlpha),
    scrollbarSliderHoverBackground: withAlpha(foreground, scrollbarHoverAlpha),
    scrollbarSliderActiveBackground: withAlpha(foreground, scrollbarHoverAlpha),
    black: mutedForeground,
    brightBlack: foreground,
    red,
    brightRed: red,
    green,
    brightGreen: green,
    yellow,
    brightYellow: yellow,
    blue,
    brightBlue: blue,
    magenta: blue,
    brightMagenta: blue,
    cyan: green,
    brightCyan: green,
    white: foreground,
    brightWhite: foreground,
  };
}

function terminalFontFamily(): string {
  if (typeof window === "undefined") {
    return '"NerdFontsSymbols Nerd Font", ui-monospace, SFMono-Regular, monospace';
  }

  const styles = window.getComputedStyle(document.documentElement);
  const monoFontFamily = readToken(
    styles,
    "--font-mono",
    "ui-monospace, SFMono-Regular, monospace",
  );
  const symbolFontFamily = readToken(
    styles,
    "--font-terminal-symbols",
    '"NerdFontsSymbols Nerd Font"',
  );

  return `${monoFontFamily}, ${symbolFontFamily}`;
}

export function TerminalPanel({
  sessionKey,
  cwd,
  collapsed = false,
  showHeader = true,
  className,
  onCollapse,
  onExpand,
  onClose,
  focusRequest = 0,
}: TerminalPanelProps) {
  const { t } = useTranslation("chat");
  const { resolvedTheme } = useTheme();
  const sectionRef = useRef<HTMLElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const previousCollapsedRef = useRef(collapsed);
  const collapsedRef = useRef(collapsed);
  const sessionRef = useRef<TerminalSession | null>(null);
  const displayPath = useMemo(() => shortenPath(cwd), [cwd]);
  const labels = useMemo<TerminalSessionLabels>(
    () => ({
      startFailed: t("terminal.startFailed"),
      stopped: t("terminal.stopped"),
      exitedWithSignal: (signal) => t("terminal.exitedWithSignal", { signal }),
    }),
    [t],
  );
  const subscribeStatus = useCallback(
    (onStoreChange: () => void) =>
      subscribeTerminalSessionStatus(sessionKey, onStoreChange),
    [sessionKey],
  );
  const getStatusSnapshot = useCallback(
    (): TerminalStatus => getTerminalSessionStatus(sessionKey) ?? "starting",
    [sessionKey],
  );
  const status = useSyncExternalStore(
    subscribeStatus,
    getStatusSnapshot,
    () => "starting",
  );
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const stopAndCloseLabel = t("terminal.stopAndCloseTab", {
    path: displayPath,
  });
  const confirmStopTitle = t("terminal.confirmStopTabTitle", {
    path: displayPath,
  });

  useEffect(() => {
    collapsedRef.current = collapsed;
  }, [collapsed]);

  useLayoutEffect(() => {
    const nextSession = getOrCreateTerminalSession({
      key: sessionKey,
      cwd,
      labels,
      theme: resolveTerminalTheme(resolvedTheme),
      fontFamily: terminalFontFamily(),
    });
    nextSession.updateLabels(labels);
    sessionRef.current = nextSession;
    if (collapsedRef.current) {
      nextSession.deferResize();
    }

    const container = containerRef.current;
    const shortKey = shortTerminalSessionKey(sessionKey);
    const start = performance.now();
    perfLog(`[perf:terminal] ${shortKey} attach immediate`);
    const detach = container ? nextSession.attach(container) : undefined;
    perfLog(
      `[perf:terminal] ${shortKey} attach complete ${(performance.now() - start).toFixed(1)}ms status=${nextSession.status} hasContainer=${Boolean(container)}`,
    );

    return () => {
      detach?.();
      if (sessionRef.current === nextSession) {
        sessionRef.current = null;
      }
    };
  }, [cwd, labels, resolvedTheme, sessionKey]);

  const handleRestart = useCallback(() => {
    sessionRef.current?.restart();
    if (collapsed) {
      onExpand?.();
    }
  }, [collapsed, onExpand]);

  const handleStop = useCallback(() => {
    sessionRef.current?.stop({ writeStopped: true });
    setStopConfirmOpen(false);
    onClose?.();
  }, [onClose]);

  const handleHeaderToggle = useCallback(() => {
    if (collapsed) {
      onExpand?.();
      return;
    }

    onCollapse?.();
  }, [collapsed, onCollapse, onExpand]);

  useEffect(() => {
    const nextSession = sessionRef.current;
    if (!nextSession) {
      return;
    }

    const wasCollapsed = previousCollapsedRef.current;
    previousCollapsedRef.current = collapsed;

    if (collapsed) {
      if (!wasCollapsed) {
        nextSession.deferResize();
      }
      return;
    }

    if (!wasCollapsed) {
      return;
    }

    // Let the height transition own the opening animation. Resizing xterm at
    // the beginning changes its measured content height/rows and creates a
    // visible mid-animation hitch; the transition-end listener below performs
    // the real fit once the shell has settled.
    nextSession.deferResize();
    const fallback = window.setTimeout(() => {
      nextSession.resumeResize({ focus: true });
    }, TERMINAL_EXPAND_RESIZE_FALLBACK_MS);

    return () => window.clearTimeout(fallback);
  }, [collapsed]);

  useEffect(() => {
    const container = containerRef.current?.closest("[data-terminal-panel]");
    if (!container) {
      return;
    }

    const handleShellTransitionEnd = () => {
      if (!collapsed) {
        sessionRef.current?.resumeResize({ focus: true });
      }
    };

    container.addEventListener(
      "goose-terminal-shell-transition-end",
      handleShellTransitionEnd,
    );
    return () => {
      container.removeEventListener(
        "goose-terminal-shell-transition-end",
        handleShellTransitionEnd,
      );
    };
  }, [collapsed]);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) {
      return;
    }

    const handleTerminalFocus = () => {
      if (!collapsed) {
        sessionRef.current?.focusAndResize();
      }
    };

    section.addEventListener("goose-terminal-focus", handleTerminalFocus);
    return () => {
      section.removeEventListener("goose-terminal-focus", handleTerminalFocus);
    };
  }, [collapsed]);

  // A user action (button, Cmd+J, tab switch) bumps focusRequest; move the
  // cursor into the terminal so it is ready to type. 0 means "no request yet"
  // so restoring an already-open terminal on reload does not steal focus.
  // While the session is still "starting" the underlying xterm is not settled
  // and an early focus does not stick, so we defer until it is "running" and
  // only handle each request once (so a later restart does not steal focus).
  const handledFocusRequestRef = useRef(0);
  useEffect(() => {
    if (
      focusRequest === 0 ||
      collapsed ||
      handledFocusRequestRef.current === focusRequest
    ) {
      return;
    }

    if (status !== "running") {
      return;
    }

    const cancel = scheduleAfterNextPaint(() => {
      handledFocusRequestRef.current = focusRequest;
      sessionRef.current?.focusAndResize();
    });
    return cancel;
  }, [collapsed, focusRequest, status]);

  return (
    <section
      ref={sectionRef}
      data-terminal-panel
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden bg-card text-foreground",
        className,
      )}
      aria-label={t("terminal.title")}
    >
      {showHeader ? (
        <div
          className={cn(
            "relative flex h-10 shrink-0 items-center gap-2 px-3",
            !collapsed && "border-b border-border/80",
          )}
        >
          <button
            type="button"
            onClick={handleHeaderToggle}
            aria-expanded={!collapsed}
            aria-label={
              collapsed ? t("terminal.expand") : t("terminal.collapse")
            }
            className="absolute inset-0 z-0 text-left outline-none transition-colors hover:bg-muted/30 focus-visible:bg-muted/30"
          />
          <div className="pointer-events-none relative z-10 min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-sm font-light">{t("terminal.title")}</span>
              <span className="truncate font-mono text-[11px] text-muted-foreground">
                {displayPath}
              </span>
            </div>
          </div>
          <Badge
            variant="secondary"
            className="pointer-events-none relative z-10 h-5 px-2 text-[10px] font-normal"
          >
            {t(`terminal.status.${status}`)}
          </Badge>
          <div className="pointer-events-none relative z-10 flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={handleRestart}
                  aria-label={t("terminal.restart")}
                  className="pointer-events-auto rounded-md"
                >
                  <IconRotateClockwise className="size-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("terminal.restart")}</TooltipContent>
            </Tooltip>
            <Popover open={stopConfirmOpen} onOpenChange={setStopConfirmOpen}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={stopAndCloseLabel}
                      className="pointer-events-auto rounded-md"
                    >
                      <IconX className="size-3" />
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
                      onClick={() => setStopConfirmOpen(false)}
                    >
                      {t("common:actions.cancel")}
                    </Button>
                    <Button
                      type="button"
                      variant="primary"
                      destructive
                      size="xs"
                      onClick={handleStop}
                    >
                      {t("terminal.stop")}
                    </Button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
            <span
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground"
              aria-hidden="true"
            >
              {collapsed ? (
                <IconChevronUp className="size-3" />
              ) : (
                <IconChevronDown className="size-3" />
              )}
            </span>
          </div>
        </div>
      ) : null}
      <div
        className={cn(
          "goose-terminal min-h-0 flex-1 overflow-hidden px-0 py-0 opacity-100 transition-opacity duration-150 ease-out motion-reduce:transition-none",
          collapsed && "h-0 flex-none p-0 opacity-0",
        )}
        aria-hidden={collapsed || undefined}
      >
        <div
          ref={containerRef}
          className="h-full min-h-0 w-full overflow-hidden rounded-md bg-transparent"
        />
      </div>
    </section>
  );
}
