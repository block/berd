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
const COMPOSER_ACTION_FEEDBACK_RECIPE = {
  active:
    "bg-info text-info-foreground hover:bg-info/90 hover:text-info-foreground active:bg-info/90 active:text-info-foreground",
  error:
    "bg-destructive text-destructive-foreground hover:bg-destructive/90 hover:text-destructive-foreground active:bg-destructive/90 active:text-destructive-foreground",
  destructive:
    "bg-destructive text-destructive-foreground hover:bg-destructive/90 hover:text-destructive-foreground active:bg-destructive/90 active:text-destructive-foreground",
} as const;

export type ComposerActionVisualState =
  keyof typeof COMPOSER_ACTION_FEEDBACK_RECIPE;

export type ComposerActionButtonProps = Omit<
  ButtonProps,
  "variant" | "flush" | "destructive"
> & {
  visualState?: ComposerActionVisualState;
};

export const ComposerActionButton = React.forwardRef<
  HTMLButtonElement,
  ComposerActionButtonProps
>(({ className, visualState, ...props }, ref) => (
  <Button
    ref={ref}
    variant="subtle"
    className={cn(
      COMPOSER_ACTION_RECIPE,
      visualState && COMPOSER_ACTION_FEEDBACK_RECIPE[visualState],
      visualState === "active" && "animate-pulse motion-reduce:animate-none",
      className,
    )}
    {...props}
  />
));
ComposerActionButton.displayName = "ComposerActionButton";
