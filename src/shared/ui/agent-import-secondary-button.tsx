import * as React from "react";

import { Button, type ButtonProps } from "@/shared/ui/button";

/**
 * Secondary action for agent import flows.
 * Uses a transparent dark-mode surface with a light gray stroke and label.
 */
export type AgentImportSecondaryButtonProps = Omit<
  ButtonProps,
  "variant" | "flush" | "destructive"
>;

export const AgentImportSecondaryButton = React.forwardRef<
  HTMLButtonElement,
  AgentImportSecondaryButtonProps
>((props, ref) => (
  <Button
    ref={ref}
    variant="outline"
    className="dark:border-muted-foreground dark:bg-transparent dark:text-muted-foreground dark:hover:border-foreground/70 dark:hover:bg-transparent dark:hover:text-foreground dark:active:bg-transparent"
    {...props}
  />
));
AgentImportSecondaryButton.displayName = "AgentImportSecondaryButton";
