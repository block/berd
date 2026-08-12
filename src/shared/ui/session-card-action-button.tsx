import * as React from "react";

import { cn } from "@/shared/lib/cn";
import { Button, type ButtonProps } from "@/shared/ui/button";

/**
 * Chrome button for the overflow ("meatball") action on a session card.
 *
 * Composes Button. Base semantic variant: `ghost`, size `icon-xs`.
 *
 * The card surface trades a piece of metadata for its actions: the card rests
 * showing a timestamp and reveals this control in the same slot on hover or
 * keyboard focus. That swap is what this recipe owns, so the reveal timing
 * matches the sibling metadata's fade instead of being re-derived per card
 * layout.
 *
 * Interactive-state contract:
 * - rest: hidden — `invisible opacity-0`, so it is out of the tab order until
 *   the card is hovered or something inside the card takes focus
 * - reveal: visible at full opacity on `group-hover` / `group-focus-within` of
 *   the card, over the same 75ms as the metadata it displaces
 * - open: stays revealed while its menu is open, whether that is driven by the
 *   `open` prop or by Radix's own `data-state` / `aria-expanded` on the trigger
 * - color: inherited from `ghost` + `icon-xs`, which rests at
 *   `muted-foreground`, raises to `foreground` on hover, and raises again while
 *   open. No fill in any state.
 *
 * Callers pass positioning only (`absolute`, `right-6 top-6`, `z-10`); the card
 * decides where the control sits, never how it looks. Requires an ancestor with
 * the `group` class — the card root.
 *
 * Intent: the recipe owns every interactive state so card chrome cannot drift
 * when the base variant changes, and so the geometry stays the named `icon-xs`
 * hit target rather than being shrunk per call site.
 */
const SESSION_CARD_ACTION_GEOMETRY =
  "rounded-sm transition-opacity duration-75";

const SESSION_CARD_ACTION_HIDDEN =
  "invisible opacity-0 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100 data-[state=open]:visible data-[state=open]:opacity-100 aria-expanded:visible aria-expanded:opacity-100";

const SESSION_CARD_ACTION_REVEALED = "visible opacity-100";

export interface SessionCardActionButtonProps
  extends Omit<ButtonProps, "variant" | "size" | "flush" | "destructive"> {
  /**
   * Pins the control open (menu showing). Cards that own their menu's open
   * state pass it so the reveal and the metadata fade stay in lockstep; the
   * recipe also honors Radix's own open attributes for uncontrolled triggers.
   */
  open?: boolean;
}

export const SessionCardActionButton = React.forwardRef<
  HTMLButtonElement,
  SessionCardActionButtonProps
>(({ className, open = false, ...props }, ref) => (
  <Button
    ref={ref}
    type="button"
    variant="ghost"
    size="icon-xs"
    className={cn(
      SESSION_CARD_ACTION_GEOMETRY,
      open ? SESSION_CARD_ACTION_REVEALED : SESSION_CARD_ACTION_HIDDEN,
      className,
    )}
    {...props}
  />
));
SessionCardActionButton.displayName = "SessionCardActionButton";
