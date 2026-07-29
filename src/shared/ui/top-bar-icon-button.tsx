import * as React from "react";

import { cn } from "@/shared/lib/cn";
import { Button, type ButtonProps } from "@/shared/ui/button";

/**
 * Chrome button for icon actions in the app top bar.
 *
 * Composes Button. Base semantic variant: `ghost`.
 *
 * Extra styling on top of ghost:
 * - never paints a hover pill (`hover:bg-transparent`)
 * - rests at the top-bar control color (`--app-top-bar-control-fg`) instead
 *   of foreground
 * - hover/active dim the whole control to
 *   `--app-top-bar-control-hover-opacity` (landmark buttons stay visible and
 *   soften on touch, the inverse of ghost flush's raise-on-hover)
 * - disabled applies opacity to the whole rendered icon, avoiding darker
 *   overlap where icon strokes intersect
 *
 * Use only in the app top bar / window chrome. For quiet icon actions inside
 * content, use `Button variant="ghost"` (or `flush`).
 *
 * Intent: the recipe deliberately owns every interactive state (rest, hover,
 * active, disabled) — including overriding ghost's hover pill — so top-bar
 * chrome can never drift when the base variant changes. The base `ghost`
 * contributes role, geometry, focus behavior, and icon sizing, not colors.
 * No flag props (`flush`/`destructive`) are used or accepted.
 */
const TOP_BAR_ICON_RECIPE =
  "bg-transparent text-app-top-bar-control-fg shadow-none transition-[color,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-transparent hover:text-app-top-bar-control-fg hover:opacity-[var(--app-top-bar-control-hover-opacity)] active:bg-transparent active:text-app-top-bar-control-fg active:opacity-[var(--app-top-bar-control-hover-opacity)] focus-visible:bg-transparent data-[state=open]:bg-transparent data-[state=open]:text-app-top-bar-control-fg aria-expanded:bg-transparent aria-expanded:text-app-top-bar-control-fg disabled:text-app-top-bar-control-fg disabled:opacity-35 disabled:hover:text-app-top-bar-control-fg disabled:hover:opacity-35 disabled:active:text-app-top-bar-control-fg disabled:active:opacity-35 disabled:focus-visible:text-app-top-bar-control-fg";

export type TopBarIconButtonProps = Omit<ButtonProps, "variant" | "flush">;

export const TopBarIconButton = React.forwardRef<
  HTMLButtonElement,
  TopBarIconButtonProps
>(({ className, size = "icon-top-bar", ...props }, ref) => (
  <Button
    ref={ref}
    variant="ghost"
    size={size}
    className={cn(TOP_BAR_ICON_RECIPE, className)}
    {...props}
  />
));
TopBarIconButton.displayName = "TopBarIconButton";
