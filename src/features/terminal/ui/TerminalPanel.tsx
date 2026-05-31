import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { cn } from "@/shared/lib/cn";
import {
  getOrCreateTerminalSession,
  type TerminalSession,
  type TerminalSessionLabels,
  type TerminalStatus,
} from "../lib/terminalSessionManager";

interface TerminalPanelProps {
  sessionKey: string;
  cwd: string;
  collapsed?: boolean;
  className?: string;
  onCollapse: () => void;
  onExpand: () => void;
  onClose: () => void;
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

function resolveTerminalTheme(): ITheme {
  if (typeof window === "undefined") {
    return {};
  }

  const styles = window.getComputedStyle(document.documentElement);
  const foreground = readToken(styles, "--foreground", "var(--foreground)");
  const background = readToken(styles, "--card", "var(--card)");
  const mutedForeground = readToken(
    styles,
    "--muted-foreground",
    "var(--muted-foreground)",
  );
  const red = readToken(styles, "--destructive", "var(--destructive)");
  const green = readToken(styles, "--success", "var(--success)");
  const yellow = readToken(styles, "--warning", "var(--warning)");
  const blue = readToken(styles, "--info", "var(--info)");

  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: readToken(styles, "--accent", "var(--accent)"),
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
    return "ui-monospace, SFMono-Regular, monospace";
  }

  const styles = window.getComputedStyle(document.documentElement);
  return readToken(
    styles,
    "--font-mono",
    "ui-monospace, SFMono-Regular, monospace",
  );
}

export function TerminalPanel({
  sessionKey,
  cwd,
  collapsed = false,
  className,
  onCollapse,
  onExpand,
  onClose,
}: TerminalPanelProps) {
  const { t } = useTranslation("chat");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const displayPath = useMemo(() => shortenPath(cwd), [cwd]);
  const labels = useMemo<TerminalSessionLabels>(
    () => ({
      startFailed: t("terminal.startFailed"),
      stopped: t("terminal.stopped"),
      exitedWithSignal: (signal) => t("terminal.exitedWithSignal", { signal }),
    }),
    [t],
  );
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [status, setStatus] = useState<TerminalStatus>("starting");

  useEffect(() => {
    const nextSession = getOrCreateTerminalSession({
      key: sessionKey,
      cwd,
      labels,
      theme: resolveTerminalTheme(),
      fontFamily: terminalFontFamily(),
    });
    nextSession.updateLabels(labels);
    setSession(nextSession);
    setStatus(nextSession.status);
  }, [cwd, labels, sessionKey]);

  useEffect(() => {
    if (!session) {
      return;
    }

    setStatus(session.status);
    return session.subscribe(() => setStatus(session.status));
  }, [session]);

  useEffect(() => {
    if (!session) {
      return;
    }

    const container = containerRef.current;
    if (!container) return;
    return session.attach(container);
  }, [session]);

  const handleRestart = useCallback(() => {
    session?.restart();
    if (collapsed) {
      onExpand();
    }
  }, [collapsed, onExpand, session]);

  const handleStop = useCallback(() => {
    session?.stop({ writeStopped: true });
    onClose();
  }, [onClose, session]);

  const handleHeaderToggle = useCallback(() => {
    if (collapsed) {
      onExpand();
      return;
    }

    onCollapse();
  }, [collapsed, onCollapse, onExpand]);

  useEffect(() => {
    if (collapsed) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      session?.focusAndResize();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [collapsed, session]);

  return (
    <section
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden bg-card text-foreground",
        className,
      )}
      aria-label={t("terminal.title")}
    >
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
          aria-label={collapsed ? t("terminal.expand") : t("terminal.collapse")}
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
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={handleStop}
                aria-label={t("terminal.stopAndClose")}
                className="pointer-events-auto rounded-md"
              >
                <IconX className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("terminal.stopAndClose")}</TooltipContent>
          </Tooltip>
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
      <div
        className={cn(
          "goose-terminal min-h-0 flex-1 overflow-hidden p-2 opacity-100 transition-opacity duration-150 ease-out motion-reduce:transition-none",
          collapsed && "h-0 flex-none p-0 opacity-0",
        )}
        aria-hidden={collapsed || undefined}
      >
        <div
          ref={containerRef}
          className="h-full min-h-0 w-full overflow-hidden rounded-md bg-transparent p-2"
        />
      </div>
    </section>
  );
}
