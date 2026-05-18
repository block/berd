import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { IconArrowLeft } from "@tabler/icons-react";

import { cn } from "@/shared/lib/cn";
import { getDesignSystemMetadata } from "@/shared/ui/design-system/metadata";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-left text-sm font-normal transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-background-primary text-text-on-primary shadow-none hover:bg-background-primary/90",
        destructive:
          "bg-background-danger-strong text-text-on-danger shadow-none hover:bg-background-danger-strong/90",
        "destructive-flat":
          "bg-background-danger-strong text-text-on-danger shadow-none hover:bg-background-danger-strong/90",
        outline:
          "border border-border-input bg-background shadow-none hover:bg-background-hover hover:text-text-hover",
        "outline-flat":
          "border border-border-soft bg-background shadow-none hover:bg-background-hover hover:text-text-hover",
        secondary:
          "bg-background-medium text-text-on-secondary hover:bg-background-medium/80",
        ghost: "hover:bg-background-hover hover:text-text-hover",
        "ghost-light":
          "font-normal hover:bg-background-hover hover:text-text-hover",
        "inline-subtle":
          "rounded-md bg-transparent font-normal text-muted-foreground shadow-none hover:bg-muted/70 hover:text-foreground",
        quiet:
          "bg-transparent font-normal text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground active:bg-transparent active:text-foreground data-[state=open]:bg-transparent data-[state=open]:text-foreground aria-expanded:bg-transparent aria-expanded:text-foreground",
        toolbar:
          "justify-start bg-transparent font-normal text-foreground shadow-none hover:bg-background-hover hover:text-text-hover active:bg-background-hover active:text-text-hover data-[state=open]:bg-background-hover data-[state=open]:text-text-hover aria-expanded:bg-background-hover aria-expanded:text-text-hover",
        back: "justify-start text-muted-foreground hover:text-foreground",
        link: "text-text-primary underline-offset-4 hover:underline",
      },
      size: {
        xxs: "h-6 gap-1.5 px-2 text-[11px] [&_svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-3",
        xs: "h-7 px-2.5 text-xs [&_svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-3",
        default:
          "h-9 px-4 py-2 [&_svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-3.5",
        sm: "h-8 px-3 text-xs [&_svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-3",
        lg: "h-10 px-8 [&_svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-4",
        icon: "h-9 w-9 [&_svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-4",
        "icon-xs":
          "h-7 w-7 [&_svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-3",
        "icon-sm":
          "h-8 w-8 [&_svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-3.5",
        "icon-lg":
          "h-10 w-10 [&_svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-5",
      },
    },
    compoundVariants: [
      {
        variant: "toolbar",
        size: "xs",
        className: "gap-1.5 px-1.5 text-[13px]",
      },
      {
        variant: "toolbar",
        size: "sm",
        className: "gap-1.5 px-2 text-[13px]",
      },
      {
        variant: "toolbar",
        size: "default",
        className: "gap-1.5 px-2.5 text-[13px]",
      },
      {
        variant: "inline-subtle",
        size: "xs",
        className: "h-6 gap-1.5 px-2 text-[11px]",
      },
      {
        variant: "back",
        size: "sm",
        className: "px-0",
      },
      {
        variant: "ghost",
        size: "icon-xs",
        className:
          "bg-transparent text-muted-foreground hover:bg-transparent hover:text-foreground active:bg-transparent data-[state=open]:text-foreground aria-expanded:text-foreground",
      },
      {
        variant: "ghost",
        size: "icon-sm",
        className:
          "bg-transparent text-muted-foreground hover:bg-transparent hover:text-foreground active:bg-transparent data-[state=open]:text-foreground aria-expanded:text-foreground",
      },
      {
        variant: "ghost",
        size: "icon",
        className:
          "bg-transparent text-muted-foreground hover:bg-transparent hover:text-foreground active:bg-transparent data-[state=open]:text-foreground aria-expanded:text-foreground",
      },
      {
        variant: "ghost",
        size: "icon-lg",
        className:
          "bg-transparent text-muted-foreground hover:bg-transparent hover:text-foreground active:bg-transparent data-[state=open]:text-foreground aria-expanded:text-foreground",
      },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

const buttonIconSizeClasses = {
  xxs: "size-3",
  xs: "size-3",
  default: "size-3.5",
  sm: "size-3",
  lg: "size-4",
  icon: "size-4",
  "icon-xs": "size-3",
  "icon-sm": "size-3.5",
  "icon-lg": "size-5",
} satisfies Record<
  NonNullable<VariantProps<typeof buttonVariants>["size"]>,
  string
>;

type ButtonIconProps = {
  className?: string;
  size?: number | string;
  width?: number | string;
  height?: number | string;
  style?: React.CSSProperties;
};

function hasExplicitIconDimensions(icon: React.ReactElement<ButtonIconProps>) {
  return (
    icon.props.size !== undefined ||
    icon.props.width !== undefined ||
    icon.props.height !== undefined ||
    icon.props.style?.width !== undefined ||
    icon.props.style?.height !== undefined
  );
}

function renderButtonIcon(
  icon: React.ReactNode,
  slot: "button-left-icon" | "button-right-icon",
  size: VariantProps<typeof buttonVariants>["size"],
) {
  if (!icon) {
    return null;
  }

  const iconSizeClass = buttonIconSizeClasses[size ?? "default"];
  const content =
    React.isValidElement<ButtonIconProps>(icon) &&
    icon.type !== React.Fragment &&
    !hasExplicitIconDimensions(icon)
      ? React.cloneElement(icon, {
          className: cn(iconSizeClass, icon.props.className),
        })
      : icon;

  return (
    <span
      data-slot={slot}
      className="inline-flex shrink-0 items-center justify-center"
    >
      {content}
    </span>
  );
}

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    leftIcon?: React.ReactNode;
    rightIcon?: React.ReactNode;
  };

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      leftIcon,
      rightIcon,
      children,
      ...props
    },
    ref,
  ) => {
    const Comp = asChild ? Slot : "button";
    const resolvedLeftIcon =
      variant === "back"
        ? (leftIcon ?? <IconArrowLeft aria-hidden="true" />)
        : leftIcon;

    return (
      <Comp
        {...getDesignSystemMetadata({
          component: "Button",
          slot: "button",
          source: "src/shared/ui/button.tsx",
          variant: variant ?? "default",
          size: size ?? "default",
          props: {
            asChild,
            disabled: props.disabled,
            leftIcon: Boolean(resolvedLeftIcon),
            rightIcon: Boolean(rightIcon),
          },
          customClassName:
            typeof className === "string" ? className : undefined,
        })}
        data-slot="button"
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      >
        {asChild ? (
          children
        ) : (
          <>
            {renderButtonIcon(resolvedLeftIcon, "button-left-icon", size)}
            {children}
            {renderButtonIcon(rightIcon, "button-right-icon", size)}
          </>
        )}
      </Comp>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
