import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

const COLLAPSE_TRANSITION_CLASS = {
  default:
    "duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
  deliberate:
    "duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
} as const;

/**
 * Shared expand/collapse animation for vertically revealed content
 * (sidebar section bodies, nested chat lists). Content stays mounted and
 * the container transitions grid-template-rows between 0fr and 1fr with a
 * fade and a slight upward settle, so every disclosure in the app shares
 * one easing and duration.
 *
 * While closed the content is hidden from assistive tech and removed from
 * the tab order via `inert`.
 */
export function CollapseReveal({
  open,
  children,
  className,
  pace = "default",
  id,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
  pace?: keyof typeof COLLAPSE_TRANSITION_CLASS;
  id?: string;
}) {
  const transitionClass = COLLAPSE_TRANSITION_CLASS[pace];

  return (
    <div
      id={id}
      className={cn(
        "grid transition-[grid-template-rows,opacity]",
        transitionClass,
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        className,
      )}
      aria-hidden={!open}
      inert={!open ? true : undefined}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          className={cn(
            "transition-transform",
            transitionClass,
            open ? "translate-y-0" : "-translate-y-1",
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
