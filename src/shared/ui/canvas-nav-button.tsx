import * as React from "react";

import { cn } from "@/shared/lib/cn";
import { Button, type ButtonProps } from "@/shared/ui/button";

/**
 * Chrome button for floating navigation over full-surface canvas takeovers
 * (e.g. the avatar collection takeover's close X / back arrow).
 *
 * Composes Button. Base semantic variant: `primary`.
 *
 * Extra styling on top of primary:
 * - carries the chat shadow so the control floats over canvas artwork
 *   instead of reading as part of it
 * - `select-none` so rapid clicks never select an icon or label
 *
 * The solid primary fill is deliberate (design direction, Berd-Updates
 * 704-3688): quiet glass controls disappeared against the takeover's
 * dot-grid canvas, so takeover navigation uses the high-contrast filled
 * treatment. This wrapper exists so that treatment is a named product
 * surface rather than a repurposed confirm action — takeover nav can be
 * restyled here without touching real primary actions, and cannot drift
 * from the shared hover/active/focus/disabled behavior `primary` owns.
 *
 * Use for close/back/dismiss controls floating over full-surface canvas
 * takeovers. For ordinary main actions, use `Button variant="primary"`;
 * for quiet controls floating over media, use `GlassButton`.
 *
 * Intent: the recipe owns every interactive state so takeover navigation
 * can never drift when the base variant changes. The base `primary`
 * contributes role, geometry, focus behavior, and icon sizing. No flag
 * props are used or accepted.
 */
const CANVAS_NAV_RECIPE = "select-none shadow-[var(--shadow-chat)]";

export type CanvasNavButtonProps = Omit<
  ButtonProps,
  "variant" | "flush" | "destructive"
>;

export const CanvasNavButton = React.forwardRef<
  HTMLButtonElement,
  CanvasNavButtonProps
>(({ className, ...props }, ref) => (
  <Button
    ref={ref}
    variant="primary"
    className={cn(CANVAS_NAV_RECIPE, className)}
    {...props}
  />
));
CanvasNavButton.displayName = "CanvasNavButton";
