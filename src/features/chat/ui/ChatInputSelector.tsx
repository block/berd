import { Fragment, useRef, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { ComposerActionButton } from "@/shared/ui/composer-action-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { cn } from "@/shared/lib/cn";
import { useComposerPickerCloseFocus } from "@/features/chat/hooks/useComposerPickerCloseFocus";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

export interface ChatInputSelectorItem {
  value: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

interface ChatInputSelectorSection {
  label?: string;
  items: ChatInputSelectorItem[];
}

interface ChatInputSelectorProps {
  ariaLabel: string;
  value: string;
  triggerLabel: string;
  triggerTitle?: string;
  icon?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onRequestComposerFocus?: () => void;
  triggerTabIndex?: number;
  triggerIconOnly?: boolean;
  triggerVariant?: "default" | "toolbar";
  triggerSize?: "default" | "sm";
  menuLabel?: string;
  sections: ChatInputSelectorSection[];
  onValueChange: (value: string) => void;
  preservesExternalFocus?: (value: string) => boolean;
  contentWidth?: "trigger" | "wide";
  contentSide?: "top" | "right" | "bottom" | "left";
  contentAlign?: "start" | "center" | "end";
  disabled?: boolean;
  modal?: boolean;
}

export function ChatInputSelector({
  ariaLabel,
  value,
  triggerLabel,
  triggerTitle,
  icon,
  open,
  onOpenChange,
  onRequestComposerFocus,
  triggerTabIndex,
  triggerVariant = "default",
  triggerSize = "default",
  menuLabel,
  sections,
  onValueChange,
  preservesExternalFocus,
  contentWidth = "trigger",
  contentSide,
  contentAlign = "start",
  disabled,
  modal,
  triggerIconOnly = false,
}: ChatInputSelectorProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const {
    beginOpenCycle,
    preserveFocusDestination,
    classifyOutsideInteraction,
    handleCloseAutoFocus,
  } = useComposerPickerCloseFocus({
    triggerRef,
    onRequestComposerFocus,
  });
  const buttonSize = triggerIconOnly
    ? "icon-pill-sm"
    : triggerSize === "sm"
      ? "xs"
      : "sm";

  const TriggerButton =
    triggerVariant === "toolbar" ? ComposerActionButton : Button;

  return (
    <DropdownMenu
      modal={modal}
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) beginOpenCycle();
        onOpenChange?.(nextOpen);
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <TriggerButton
              ref={triggerRef}
              type="button"
              {...(triggerVariant === "toolbar"
                ? {}
                : { variant: "outline" as const })}
              size={buttonSize}
              aria-label={ariaLabel}
              tabIndex={triggerTabIndex}
              disabled={disabled}
              leftIcon={icon}
              rightIcon={triggerIconOnly ? undefined : <ChevronDown />}
              className={cn(
                "chat-composer-selector-trigger",
                triggerIconOnly ? "shrink-0" : "min-w-0",
                triggerVariant === "default" &&
                  !triggerIconOnly &&
                  "justify-between",
                triggerVariant === "toolbar" && !triggerIconOnly && "max-w-40",
              )}
            >
              {triggerIconOnly ? null : (
                <span className="chat-composer-selector-label truncate">
                  {triggerLabel}
                </span>
              )}
            </TriggerButton>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        {triggerTitle ? (
          <TooltipContent side="top">{triggerTitle}</TooltipContent>
        ) : null}
      </Tooltip>
      <DropdownMenuContent
        align={contentAlign}
        side={contentSide}
        className={cn(contentWidth === "wide" ? "w-72" : "w-56")}
        onInteractOutside={(event) => {
          classifyOutsideInteraction(event.target);
        }}
        onCloseAutoFocus={handleCloseAutoFocus}
      >
        {menuLabel ? (
          <>
            <DropdownMenuGroup>
              <DropdownMenuLabel>{menuLabel}</DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {sections.map((section, sectionIndex) => {
          const sectionKey =
            section.label ??
            `${ariaLabel}-${section.items.map((item) => item.value).join("|")}`;

          return (
            <Fragment key={sectionKey}>
              <DropdownMenuGroup className="space-y-0.5">
                {section.label ? (
                  <DropdownMenuLabel>{section.label}</DropdownMenuLabel>
                ) : null}
                {section.items.map((item) => {
                  const isSelected = item.value === value;

                  return (
                    <DropdownMenuItem
                      key={item.value}
                      disabled={item.disabled}
                      onSelect={() => {
                        if (preservesExternalFocus?.(item.value)) {
                          preserveFocusDestination();
                        }
                        onValueChange(item.value);
                      }}
                      className={cn(
                        "justify-between gap-2",
                        isSelected && "bg-accent",
                      )}
                    >
                      <div
                        className={cn(
                          "min-w-0 flex flex-1 gap-2",
                          item.description ? "items-start" : "items-center",
                        )}
                      >
                        {item.icon ? (
                          <span className="shrink-0">{item.icon}</span>
                        ) : null}
                        <div className="min-w-0 flex-1">
                          <span className="block truncate font-normal">
                            {item.label}
                          </span>
                          {item.description ? (
                            <span className="block truncate text-xs text-muted-foreground">
                              {item.description}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      {isSelected ? (
                        <Check className="size-4 shrink-0 self-center text-muted-foreground" />
                      ) : null}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuGroup>
              {sectionIndex < sections.length - 1 ? (
                <DropdownMenuSeparator />
              ) : null}
            </Fragment>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
