import * as React from "react";

import { cn } from "@/shared/lib/cn";
import { Button, type ButtonProps } from "@/shared/ui/button";

/**
 * Chrome button for controls floating over media or canvas artwork
 * (e.g. the Home canvas "Recenter" control).
 *
 * Composes Button. Base semantic variant: `subtle`.
 *
 * Extra styling on top of subtle:
 * - fill swaps accent -> the strong glass surface tokens
 *   (`--surface-glass-strong` / `-hover` / `-fg`), which stay a light
 *   glass with dark text even in dark mode so the control reads over
 *   arbitrary imagery
 * - carries the chat shadow and backdrop blur so it floats
 *
 * Use for actions overlaid on media, canvases, or artwork. On ordinary
 * content surfaces, use `Button variant="subtle"`.
 *
 * Intent: the recipe owns every interactive state so glass chrome can never
 * drift when the base variant changes. The base `subtle` contributes role,
 * geometry, focus behavior, and icon sizing, not colors. No flag props are
 * used or accepted.
 */
const GLASS_RECIPE =
  "bg-surface-glass-strong text-surface-glass-strong-fg shadow-[var(--shadow-chat)] backdrop-blur-md hover:bg-surface-glass-strong-hover hover:text-surface-glass-strong-fg active:bg-surface-glass-strong data-[state=open]:bg-surface-glass-strong aria-expanded:bg-surface-glass-strong";

export type GlassButtonProps = Omit<
  ButtonProps,
  "variant" | "flush" | "destructive"
>;

export const GlassButton = React.forwardRef<
  HTMLButtonElement,
  GlassButtonProps
>(({ className, ...props }, ref) => (
  <Button
    ref={ref}
    variant="subtle"
    className={cn(GLASS_RECIPE, className)}
    {...props}
  />
));
GlassButton.displayName = "GlassButton";
