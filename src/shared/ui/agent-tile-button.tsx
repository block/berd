import * as React from "react";

import { cn } from "@/shared/lib/cn";
import { Button, type ButtonProps } from "@/shared/ui/button";

/**
 * Chrome button for actions floating on agent persona tiles.
 *
 * Composes Button. Base semantic variant: `subtle`.
 *
 * Extra styling on top of subtle:
 * - fill/label use the agent tile action tokens
 *   (`--surface-agent-tile-action-bg`/`-fg`: background/foreground pair)
 *   instead of `accent`
 * - hover/active/open invert to solid (`-bg-hover` = foreground,
 *   `-fg-hover` = background) — a high-contrast flip so the action reads
 *   over arbitrary tile artwork
 * - carries the chat shadow and backdrop blur so it floats over media
 *
 * Use only for controls overlaid on agent/persona tiles. On ordinary
 * surfaces, use `Button variant="subtle"`.
 *
 * Intent: the recipe owns every interactive state so tile chrome can never
 * drift when the base variant changes. The base `subtle` contributes role,
 * geometry, focus behavior, and icon sizing, not colors. No flag props are
 * used or accepted.
 */
const AGENT_TILE_RECIPE =
  "bg-surface-agent-tile-action-bg text-surface-agent-tile-action-fg shadow-[var(--shadow-chat)] backdrop-blur-md hover:bg-surface-agent-tile-action-bg-hover hover:text-surface-agent-tile-action-fg-hover active:bg-surface-agent-tile-action-bg-hover active:text-surface-agent-tile-action-fg-hover data-[state=open]:bg-surface-agent-tile-action-bg-hover data-[state=open]:text-surface-agent-tile-action-fg-hover aria-expanded:bg-surface-agent-tile-action-bg-hover aria-expanded:text-surface-agent-tile-action-fg-hover";

export type AgentTileButtonProps = Omit<
  ButtonProps,
  "variant" | "flush" | "destructive"
>;

export const AgentTileButton = React.forwardRef<
  HTMLButtonElement,
  AgentTileButtonProps
>(({ className, ...props }, ref) => (
  <Button
    ref={ref}
    variant="subtle"
    className={cn(AGENT_TILE_RECIPE, className)}
    {...props}
  />
));
AgentTileButton.displayName = "AgentTileButton";
