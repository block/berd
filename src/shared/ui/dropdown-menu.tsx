import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { CheckIcon, ChevronRightIcon, CircleIcon } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { getDesignSystemMetadata } from "@/shared/ui/design-system/metadata";

type DropdownMenuVariant = "default" | "inverse";

const DropdownMenuVariantContext =
  React.createContext<DropdownMenuVariant>("default");

function DropdownMenu({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return (
    <DropdownMenuPrimitive.Root
      {...getDesignSystemMetadata({
        component: "DropdownMenu",
        slot: "dropdown-menu",
        source: "src/shared/ui/dropdown-menu.tsx",
      })}
      data-slot="dropdown-menu"
      {...props}
    />
  );
}

function DropdownMenuPortal({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
  return (
    <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />
  );
}

function DropdownMenuTrigger({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return (
    <DropdownMenuPrimitive.Trigger
      {...getDesignSystemMetadata({
        component: "DropdownMenu",
        slot: "dropdown-menu-trigger",
        source: "src/shared/ui/dropdown-menu.tsx",
      })}
      data-slot="dropdown-menu-trigger"
      {...props}
    />
  );
}

function DropdownMenuContent({
  className,
  sideOffset = 4,
  variant = "default",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content> & {
  variant?: DropdownMenuVariant;
}) {
  const isInverse = variant === "inverse";
  return (
    <DropdownMenuVariantContext.Provider value={variant}>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          {...getDesignSystemMetadata({
            component: "DropdownMenu",
            slot: "dropdown-menu-content",
            source: "src/shared/ui/dropdown-menu.tsx",
            variant,
            props: { sideOffset },
            customClassName:
              typeof className === "string" ? className : undefined,
          })}
          data-slot="dropdown-menu-content"
          data-variant={variant}
          sideOffset={sideOffset}
          className={cn(
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto shadow-popover",
            isInverse
              ? "bg-popover-inverse text-popover-inverse-foreground shadow-popover-inverse rounded-[10px] px-2 py-1.5"
              : "bg-popover text-foreground rounded-overlay p-1.5",
            className,
          )}
          {...props}
        />
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuVariantContext.Provider>
  );
}

function DropdownMenuGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return (
    <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
  );
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  const menuVariant = React.useContext(DropdownMenuVariantContext);
  const isInverse = menuVariant === "inverse";
  return (
    <DropdownMenuPrimitive.Item
      {...getDesignSystemMetadata({
        component: "DropdownMenu",
        slot: "dropdown-menu-item",
        source: "src/shared/ui/dropdown-menu.tsx",
        variant,
        props: {
          inset: Boolean(inset),
          disabled: props.disabled,
          menuVariant,
        },
        customClassName: typeof className === "string" ? className : undefined,
      })}
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "relative flex cursor-pointer items-center gap-2 outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        isInverse
          ? "text-popover-inverse-foreground focus:text-popover-inverse-foreground focus:bg-white/10 rounded-[4px] px-1 py-1 text-xs leading-tight"
          : "text-foreground focus:bg-accent focus:text-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:!text-destructive [&_svg:not([class*='text-'])]:text-muted-foreground rounded-sm px-2 py-1.5 text-sm",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      {...getDesignSystemMetadata({
        component: "DropdownMenu",
        slot: "dropdown-menu-checkbox-item",
        source: "src/shared/ui/dropdown-menu.tsx",
        props: {
          checked: checked === "indeterminate" ? "indeterminate" : checked,
          disabled: props.disabled,
        },
        customClassName: typeof className === "string" ? className : undefined,
      })}
      data-slot="dropdown-menu-checkbox-item"
      className={cn(
        "text-foreground focus:bg-accent focus:text-foreground relative flex cursor-pointer items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      checked={checked}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return (
    <DropdownMenuPrimitive.RadioGroup
      data-slot="dropdown-menu-radio-group"
      {...props}
    />
  );
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      {...getDesignSystemMetadata({
        component: "DropdownMenu",
        slot: "dropdown-menu-radio-item",
        source: "src/shared/ui/dropdown-menu.tsx",
        props: {
          value: props.value,
          disabled: props.disabled,
        },
        customClassName: typeof className === "string" ? className : undefined,
      })}
      data-slot="dropdown-menu-radio-item"
      className={cn(
        "text-foreground focus:bg-accent focus:text-foreground relative flex cursor-pointer items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CircleIcon className="size-2 fill-current" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.Label
      {...getDesignSystemMetadata({
        component: "DropdownMenu",
        slot: "dropdown-menu-label",
        source: "src/shared/ui/dropdown-menu.tsx",
        props: { inset: Boolean(inset) },
        customClassName: typeof className === "string" ? className : undefined,
      })}
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn("px-2 py-1.5 text-sm data-[inset]:pl-8", className)}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      {...getDesignSystemMetadata({
        component: "DropdownMenu",
        slot: "dropdown-menu-separator",
        source: "src/shared/ui/dropdown-menu.tsx",
        customClassName: typeof className === "string" ? className : undefined,
      })}
      data-slot="dropdown-menu-separator"
      className={cn("bg-border -mx-1 my-1 h-px", className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        "text-muted-foreground ml-auto text-xs tracking-widest",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSub({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      {...getDesignSystemMetadata({
        component: "DropdownMenu",
        slot: "dropdown-menu-sub-trigger",
        source: "src/shared/ui/dropdown-menu.tsx",
        props: { inset: Boolean(inset) },
        customClassName: typeof className === "string" ? className : undefined,
      })}
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "text-foreground focus:bg-accent focus:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground flex cursor-pointer items-center rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[inset]:pl-8",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.SubContent
      {...getDesignSystemMetadata({
        component: "DropdownMenu",
        slot: "dropdown-menu-sub-content",
        source: "src/shared/ui/dropdown-menu.tsx",
        customClassName: typeof className === "string" ? className : undefined,
      })}
      data-slot="dropdown-menu-sub-content"
      className={cn(
        "bg-popover text-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden rounded-overlay p-1 shadow-popover",
        className,
      )}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
