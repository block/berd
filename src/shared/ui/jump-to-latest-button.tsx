import * as React from "react";

import { cn } from "@/shared/lib/cn";
import { Button, type ButtonProps } from "@/shared/ui/button";

/**
 * Chrome button for floating action pills overlaid on the chat transcript.
 *
 * Documented consumers (restyle one, restyle all — that is the point):
 * - the "jump to latest" back-to-live-edge control
 * - the "quote in message" selection affordance
 *
 * Composes Button. Base semantic variant: `primary`.
 *
 * Extra styling on top of primary:
 * - fill/label swap primary tokens -> the responding-pill surface tokens
 *   (`--surface-chat-responding-pill-bg` / `-fg`)
 * - carries the chat shadow so it floats over the transcript
 * - `select-none` so rapid clicks never select the label
 * - hover dims the pill to 90% opacity instead of shifting color
 *
 * Use for floating action pills over streams, feeds, or transcript
 * content. For ordinary main actions, use `Button variant="primary"`.
 *
 * Intent: the recipe owns every interactive state so the pill can never
 * drift when the base variant changes. The base `primary` contributes role,
 * geometry, focus behavior, and icon sizing, not colors. No flag props are
 * used or accepted.
 */
const JUMP_TO_LATEST_RECIPE =
  "select-none bg-surface-chat-responding-pill-bg text-surface-chat-responding-pill-fg shadow-[var(--shadow-chat)] hover:bg-surface-chat-responding-pill-bg hover:opacity-90";

export type JumpToLatestButtonProps = Omit<
  ButtonProps,
  "variant" | "flush" | "destructive"
>;

export const JumpToLatestButton = React.forwardRef<
  HTMLButtonElement,
  JumpToLatestButtonProps
>(({ className, ...props }, ref) => (
  <Button
    ref={ref}
    variant="primary"
    className={cn(JUMP_TO_LATEST_RECIPE, className)}
    {...props}
  />
));
JumpToLatestButton.displayName = "JumpToLatestButton";
