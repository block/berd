import { type ReactNode, forwardRef } from "react";
import { cn } from "@/shared/lib/cn";

export const PaneSurface = forwardRef<
  HTMLDivElement,
  {
    children: ReactNode;
    className?: string;
    dataAttributes?: Record<string, boolean | string | undefined>;
    fullHeight?: boolean;
    glass?: boolean;
    testId: string;
    width?: number;
  }
>(function PaneSurface(
  {
    children,
    className,
    dataAttributes,
    fullHeight = false,
    glass = true,
    testId,
    width,
  },
  ref,
) {
  return (
    <div
      ref={ref}
      data-testid={testId}
      className={cn(
        "relative flex flex-shrink-0 flex-col overflow-hidden rounded-md",
        glass
          ? "bg-sidebar-navigation-panel-bg backdrop-blur-md"
          : "bg-transparent",
        fullHeight && "h-full",
        className,
      )}
      style={{
        ...(glass
          ? {
              backdropFilter: "var(--backdrop-sidebar-panel)",
              WebkitBackdropFilter: "var(--backdrop-sidebar-panel)",
            }
          : null),
        width,
      }}
      {...dataAttributes}
    >
      {children}
    </div>
  );
});

export function PaneLayoutFrame({
  children,
  className,
  testId,
  width,
}: {
  children: ReactNode;
  className?: string;
  testId: string;
  width: number;
}) {
  return (
    <div
      className={cn("relative h-full", className)}
      style={{ width }}
      data-testid={testId}
    >
      <div className="relative z-10 flex h-full flex-col">{children}</div>
    </div>
  );
}
