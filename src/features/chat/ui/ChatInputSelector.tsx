import { Fragment, useRef, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Button } from "@/shared/ui/button";
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
  triggerTabIndex?: number;
  triggerIconOnly?: boolean;
  triggerVariant?: "default" | "toolbar";
  triggerSize?: "default" | "sm";
  menuLabel?: string;
  sections: ChatInputSelectorSection[];
  onValueChange: (value: string) => void;
  contentWidth?: "trigger" | "wide";
  contentSide?: "top" | "right" | "bottom" | "left";
  contentAlign?: "start" | "center" | "end";
  disabled?: boolean;
}

export function ChatInputSelector({
  ariaLabel,
  value,
  triggerLabel,
  triggerTitle,
  icon,
  open,
  onOpenChange,
  triggerTabIndex,
  triggerVariant = "default",
  triggerSize = "default",
  menuLabel,
  sections,
  onValueChange,
  contentWidth = "trigger",
  contentSide,
  contentAlign = "start",
  disabled,
  triggerIconOnly = false,
}: ChatInputSelectorProps) {
  const skipCloseAutoFocusRef = useRef(false);
  const buttonSize = triggerIconOnly
    ? "icon-pill-sm"
    : triggerSize === "sm"
      ? "xs"
      : "sm";

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={triggerVariant === "toolbar" ? "composer-action" : "outline"}
          size={buttonSize}
          aria-label={ariaLabel}
          title={triggerTitle}
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
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={contentAlign}
        side={contentSide}
        className={cn(contentWidth === "wide" ? "w-72" : "w-56")}
        onInteractOutside={() => {
          skipCloseAutoFocusRef.current = true;
        }}
        onCloseAutoFocus={(event) => {
          if (!skipCloseAutoFocusRef.current) {
            return;
          }
          skipCloseAutoFocusRef.current = false;
          event.preventDefault();
        }}
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
                      onSelect={() => onValueChange(item.value)}
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
