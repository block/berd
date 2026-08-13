import * as React from "react";

import { Button, type ButtonProps } from "@/shared/ui/button";

/**
 * Primary confirmation action for the agent import flow.
 * Uses the system primary fill (black in light mode) and preserves the
 * import-dialog-specific dark treatment without an outline.
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
    variant="primary"
    className="border-0 ring-0 dark:bg-background dark:text-foreground dark:shadow-none dark:hover:bg-background dark:hover:text-foreground dark:active:bg-background"
    {...props}
  />
));
AgentImportPrimaryButton.displayName = "AgentImportPrimaryButton";
