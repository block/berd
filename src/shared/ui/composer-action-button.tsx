import * as React from "react";

import { cn } from "@/shared/lib/cn";
import { Button, type ButtonProps } from "@/shared/ui/button";

/**
 * Chrome button for actions inside the chat composer surface.
 *
 * Composes Button. Base semantic variant: `subtle`.
 *
 * Extra styling on top of subtle:
 * - fill uses the composer surface tokens (`--surface-composer-action`,
 *   gray-300-family) instead of `accent` — the composer's glass surface
 *   needs a stronger fill than content surfaces
 * - hover/active/open states step through the composer action tokens
 *   (`-hover`, `-active`) instead of `accent-hover`
 * - label pins to `foreground` in every state
 *
 * Use only for controls that sit on the composer pill / chat input surface.
 * On ordinary content surfaces, use `Button variant="subtle"`.
 *
 * Intent: the recipe owns every interactive state so composer chrome can
 * never drift when the base variant changes. The base `subtle` contributes
 * role, geometry, focus behavior, and icon sizing, not colors. No flag
 * props are used or accepted.
 */
const COMPOSER_ACTION_RECIPE =
  "bg-surface-composer-action text-foreground shadow-none hover:bg-surface-composer-action-hover hover:text-foreground active:bg-surface-composer-action-active active:text-foreground data-[state=open]:bg-surface-composer-action-hover data-[state=open]:text-foreground aria-expanded:bg-surface-composer-action-hover aria-expanded:text-foreground";

export type ComposerActionButtonProps = Omit<
  ButtonProps,
  "variant" | "flush" | "destructive"
>;

export const ComposerActionButton = React.forwardRef<
  HTMLButtonElement,
  ComposerActionButtonProps
>(({ className, ...props }, ref) => (
  <Button
    ref={ref}
    variant="subtle"
    className={cn(COMPOSER_ACTION_RECIPE, className)}
    {...props}
  />
));
ComposerActionButton.displayName = "ComposerActionButton";
