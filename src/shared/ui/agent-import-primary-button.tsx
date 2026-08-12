import * as React from "react";

import { Button, type ButtonProps } from "@/shared/ui/button";

/**
 * Primary confirmation action for the agent import flow.
 * Uses a solid black fill on dark import-dialog surfaces without an outline.
 */
export type AgentImportPrimaryButtonProps = Omit<
  ButtonProps,
  "variant" | "flush" | "destructive"
>;

export const AgentImportPrimaryButton = React.forwardRef<
  HTMLButtonElement,
  AgentImportPrimaryButtonProps
>((props, ref) => (
  <Button
    ref={ref}
    variant="subtle"
    className="border-0 ring-0 dark:bg-background dark:text-foreground dark:shadow-none dark:hover:bg-background dark:hover:text-foreground dark:active:bg-background"
    {...props}
  />
));
AgentImportPrimaryButton.displayName = "AgentImportPrimaryButton";
