import * as React from "react";

import { cn } from "@/shared/lib/cn";
import { Button, type ButtonProps } from "@/shared/ui/button";

/**
 * Icon control for the floating voice-conversation surface.
 *
 * Composes the subtle Button treatment and gives `speaking` one narrow,
 * consistent meaning: live user or assistant speech activity. The recipe owns
 * the active colors and reduced-motion-safe pulse so feature code only chooses
 * whether the corresponding participant is speaking.
 */
const SPEAKING_RECIPE =
  "bg-primary/15 text-primary ring-2 ring-primary/50 hover:bg-primary/20 hover:text-primary active:bg-primary/20 active:text-primary motion-safe:animate-pulse";

export type VoiceConversationButtonProps = Omit<
  ButtonProps,
  "variant" | "flush" | "destructive"
> & {
  speaking?: boolean;
};

export const VoiceConversationButton = React.forwardRef<
  HTMLButtonElement,
  VoiceConversationButtonProps
>(({ className, speaking = false, ...props }, ref) => (
  <Button
    {...props}
    ref={ref}
    variant="subtle"
    data-speaking={speaking || undefined}
    className={cn(speaking && SPEAKING_RECIPE, className)}
  />
));
VoiceConversationButton.displayName = "VoiceConversationButton";
