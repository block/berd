import { motion } from "motion/react";

const TERMINAL_DOCK_PREVIEW_TRANSITION = {
  type: "spring",
  duration: 0.24,
  bounce: 0,
} as const;

interface TerminalDockPreviewProps {
  height: number;
  surface: "chatColumn" | "rightRail";
}

export function TerminalDockPreview({
  height,
  surface,
}: TerminalDockPreviewProps) {
  return (
    <motion.div
      key={`terminal-${surface}-dock-preview`}
      data-terminal-dock-preview={surface === "chatColumn" ? true : undefined}
      data-terminal-rail-dock-preview={
        surface === "rightRail" ? true : undefined
      }
      initial={{ height: 0, opacity: 0 }}
      animate={{ height, opacity: 1 }}
      transition={TERMINAL_DOCK_PREVIEW_TRANSITION}
      className="mt-[var(--spacing-app-panel-gutter-inline)] shrink-0 overflow-hidden p-1"
      aria-hidden="true"
    >
      <div className="h-full rounded-md border border-dashed border-border/70 bg-surface-glass-strong/55 shadow-[var(--shadow-mini)] [backdrop-filter:var(--backdrop-glass-subtle)] [-webkit-backdrop-filter:var(--backdrop-glass-subtle)]" />
    </motion.div>
  );
}
