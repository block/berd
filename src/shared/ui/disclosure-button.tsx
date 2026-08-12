import * as React from "react";

import { cn } from "@/shared/lib/cn";
import { Button, type ButtonProps } from "@/shared/ui/button";

/**
 * Quiet disclosure action used for "View more", "View less", and "View all"
 * affordances across the app.
 *
 * The concept is surface-neutral: a ghost text button that rests quiet and
 * rises on hover. Each `surface` is a *complete* recipe, because how quiet the
 * rest state can afford to be depends on what the button sits on.
 *
 * - `default` — inherits the design system's `ghost + flush` states
 *   (`muted-foreground` at rest, `foreground` on hover). Correct on tinted
 *   raised surfaces such as the chat user bubble, where the surface itself
 *   already consumes part of the contrast range.
 * - `sidebar` — dims the rest state to `muted-foreground/75` and caps hover at
 *   `muted-foreground`. Only legible because the sidebar sits on the page
 *   background; do not reuse it on a tinted surface.
 * - `sidebarRow` — `sidebar` quieting plus full-width sidebar row hover fills,
 *   for disclosures that read as another row in a nav list.
 */
export type DisclosureButtonSurface = "default" | "sidebar" | "sidebarRow";

const SIDEBAR_QUIET_RECIPE =
  "text-muted-foreground/75 hover:text-muted-foreground active:text-muted-foreground";
const SIDEBAR_ROW_RECIPE =
  "hover:bg-[var(--sidebar-row-hover)] active:bg-[var(--sidebar-row-active)] focus-visible:bg-[var(--sidebar-row-hover)]";

export type DisclosureButtonProps = Omit<
  ButtonProps,
  "variant" | "flush" | "size"
> & {
  surface?: DisclosureButtonSurface;
};

export const DisclosureButton = React.forwardRef<
  HTMLButtonElement,
  DisclosureButtonProps
>(({ className, surface = "default", ...props }, ref) => (
  <Button
    ref={ref}
    variant="ghost"
    // Row disclosures carry a hover fill, so they keep the padded pill
    // geometry. Inline disclosures sit flush with surrounding content.
    flush={surface !== "sidebarRow"}
    size="xs"
    className={cn(
      surface !== "default" && SIDEBAR_QUIET_RECIPE,
      surface === "sidebarRow" && SIDEBAR_ROW_RECIPE,
      className,
    )}
    {...props}
  />
));
DisclosureButton.displayName = "DisclosureButton";
