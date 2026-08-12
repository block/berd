import * as React from "react";

import { cn } from "@/shared/lib/cn";
import { Button, type ButtonProps } from "@/shared/ui/button";
import { APP_CHROME_NAV_TEXT_IMPORTANT_CLASS } from "@/shared/ui/sidebar-tokens";

/**
 * Chrome button for view-header actions on the app canvas (the pills
 * rendered into the top strip via setTopBarActions: "New agent",
 * "Search chat", "Unpin chat", ...).
 *
 * Composes Button. Base semantic variant: `subtle`.
 *
 * Extra styling on top of subtle:
 * - fill is `background` (paper — the `card` alias) instead of `accent` — the pill
 *   self-defends over the tinted canvas chrome, where an accent fill
 *   would look dirty
 * - label rests at `muted-foreground` and raises to `foreground` on
 *   hover/active/focus; the fill never changes (label-raise recipe,
 *   like ghost flush but on a filled pill)
 * - compact chrome geometry: 30px height, tighter gap/padding, and the
 *   app chrome nav text scale instead of the xs button scale
 *
 * Use only for actions rendered into the app top strip / view headers.
 * Inside page content, use `Button variant="subtle"`.
 *
 * Intent: the recipe owns every interactive state so header chrome can
 * never drift when the base variant changes. The base `subtle` contributes
 * role, focus behavior, and icon sizing; the wrapper owns geometry (30px
 * chrome height) and all colors. No flag props are used or accepted.
 */
const PAGE_HEADER_RECIPE =
  "bg-background text-muted-foreground shadow-none hover:bg-background hover:text-foreground focus-visible:text-foreground active:text-foreground";

const PAGE_HEADER_GEOMETRY = cn(
  "!h-[30px] !gap-[5px] !px-3",
  APP_CHROME_NAV_TEXT_IMPORTANT_CLASS,
  "[&_svg]:!size-3.5",
);

export type PageHeaderButtonProps = Omit<
  ButtonProps,
  "variant" | "size" | "flush" | "destructive"
>;

export const PageHeaderButton = React.forwardRef<
  HTMLButtonElement,
  PageHeaderButtonProps
>(({ className, ...props }, ref) => (
  <Button
    ref={ref}
    variant="subtle"
    size="xs"
    className={cn(PAGE_HEADER_RECIPE, PAGE_HEADER_GEOMETRY, className)}
    {...props}
  />
));
PageHeaderButton.displayName = "PageHeaderButton";
