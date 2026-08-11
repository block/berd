import * as React from "react";

import { cn } from "@/shared/lib/cn";
import { Button, type ButtonProps } from "@/shared/ui/button";

/**
 * Secondary action shown after expanding the add-agent gallery tile.
 * Uses the semantic card surface and changes only its dark-mode opacity on
 * hover, without adding a border or shadow.
 */
const AGENT_ADD_CHOICE_RECIPE =
  "border-transparent bg-card text-foreground shadow-none hover:border-transparent hover:bg-card hover:text-foreground active:bg-card active:text-foreground dark:bg-background/35 dark:hover:bg-background/45 dark:active:bg-background/45";

export type AgentAddChoiceButtonProps = Omit<
  ButtonProps,
  "variant" | "flush" | "destructive"
>;

export const AgentAddChoiceButton = React.forwardRef<
  HTMLButtonElement,
  AgentAddChoiceButtonProps
>(({ className, ...props }, ref) => (
  <Button
    ref={ref}
    variant="outline"
    className={cn(AGENT_ADD_CHOICE_RECIPE, className)}
    {...props}
  />
));
AgentAddChoiceButton.displayName = "AgentAddChoiceButton";
