import type * as React from "react";
import { IconChevronDown } from "@tabler/icons-react";
import { cn } from "@/shared/lib/cn";
import { Button, type ButtonProps } from "@/shared/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";

export interface SplitButtonAction<T extends string = string> {
  id: T;
  label: React.ReactNode;
  disabled?: boolean;
}

interface SplitButtonProps<T extends string = string> {
  actions: SplitButtonAction<T>[];
  activeActionId: T;
  onPrimaryClick: (actionId: T) => void;
  onActionSelect: (actionId: T) => void;
  disabled?: boolean;
  className?: string;
  menuTriggerLabel: string;
  menuTooltip?: React.ReactNode;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  feedbackState?: ButtonProps["feedbackState"];
  loadingLabel?: React.ReactNode;
  menuLayer?: React.ComponentProps<typeof DropdownMenuContent>["layer"];
}

export function SplitButton<T extends string = string>({
  actions,
  activeActionId,
  onPrimaryClick,
  onActionSelect,
  disabled = false,
  className,
  menuTriggerLabel,
  menuTooltip,
  variant = "outline",
  size = "xs",
  feedbackState = "idle",
  loadingLabel,
  menuLayer = "default",
}: SplitButtonProps<T>) {
  const activeAction =
    actions.find((action) => action.id === activeActionId) ?? actions[0];

  if (!activeAction) {
    return null;
  }

  const isPrimaryDisabled = disabled || activeAction.disabled;

  return (
    <div className={cn("inline-flex items-stretch", className)}>
      <Button
        type="button"
        variant={variant}
        size={size}
        disabled={isPrimaryDisabled}
        feedbackState={feedbackState}
        loadingLabel={loadingLabel}
        className="rounded-r-none border-r-0 font-normal"
        onClick={() => onPrimaryClick(activeAction.id)}
      >
        {activeAction.label}
      </Button>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant={variant}
                size={size}
                disabled={disabled}
                className="rounded-l-none px-2"
                aria-label={menuTriggerLabel}
              >
                <IconChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          {menuTooltip ? (
            <TooltipContent layer={menuLayer}>{menuTooltip}</TooltipContent>
          ) : null}
        </Tooltip>
        <DropdownMenuContent align="end" sideOffset={4} layer={menuLayer}>
          {actions.map((action) => (
            <DropdownMenuItem
              key={action.id}
              className="font-light"
              disabled={disabled || action.disabled}
              onSelect={() => {
                onActionSelect(action.id);
                onPrimaryClick(action.id);
              }}
            >
              {action.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
