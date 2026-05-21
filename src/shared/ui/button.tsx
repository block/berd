import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { IconArrowLeft } from "@tabler/icons-react";

import { cn } from "@/shared/lib/cn";
import { getDesignSystemMetadata } from "@/shared/ui/design-system/metadata";
import { Spinner } from "@/shared/ui/spinner";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-left text-sm font-normal transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-none hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground shadow-none hover:bg-destructive/90",
        "destructive-flat":
          "bg-destructive text-destructive-foreground shadow-none hover:bg-destructive/90",
        outline:
          "border border-input bg-background shadow-none hover:bg-accent hover:text-accent-foreground",
        "outline-flat":
          "border border-border/80 bg-background shadow-none hover:bg-accent hover:text-accent-foreground",
        secondary:
          "border border-input bg-accent text-accent-foreground hover:bg-accent",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        "ghost-light":
          "font-normal hover:bg-accent hover:text-accent-foreground",
        "inline-subtle":
          "rounded-md bg-transparent font-normal text-muted-foreground shadow-none hover:bg-muted/70 hover:text-foreground",
        quiet:
          "bg-transparent font-normal text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground active:bg-transparent active:text-foreground data-[state=open]:bg-transparent data-[state=open]:text-foreground aria-expanded:bg-transparent aria-expanded:text-foreground",
        toolbar:
          "justify-start bg-transparent font-normal text-foreground shadow-none hover:bg-accent hover:text-accent-foreground active:bg-accent active:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground aria-expanded:bg-accent aria-expanded:text-accent-foreground",
        "page-header":
          "bg-background text-muted-foreground shadow-none hover:bg-background hover:text-foreground focus-visible:text-foreground active:text-foreground",
        back: "justify-start text-muted-foreground hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
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
        variant: "page-header",
        size: "xs",
        className:
          "!h-[30px] !gap-[5px] !px-3 !text-[14px] !leading-[15px] [&_svg]:!size-3.5",
      },
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

export type ButtonFeedbackState = "idle" | "loading" | "success" | "error";

type ButtonLoadingVisual = "text" | "spinner" | "spinnerText";

function getButtonSpinnerClass(
  size: VariantProps<typeof buttonVariants>["size"],
) {
  switch (size) {
    case "xs":
    case "sm":
    case "icon-xs":
      return "size-3";
    case "lg":
    case "icon-lg":
      return "size-4";
    default:
      return "size-3.5";
  }
}

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
    feedbackState?: ButtonFeedbackState;
    loadingLabel?: React.ReactNode;
    successLabel?: React.ReactNode;
    errorLabel?: React.ReactNode;
    loadingDelayMs?: number;
    loadingVisual?: ButtonLoadingVisual;
    preserveWidth?: boolean;
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
      feedbackState = "idle",
      loadingLabel = "Loading...",
      successLabel,
      errorLabel,
      loadingDelayMs = 0,
      loadingVisual = "spinnerText",
      preserveWidth = false,
      disabled,
      onClick,
      ...props
    },
    ref,
  ) => {
    const [displayStatus, setDisplayStatus] =
      React.useState<ButtonFeedbackState>(feedbackState);
    const Comp = asChild ? Slot : "button";
    const childContent =
      asChild &&
      React.isValidElement<{ children?: React.ReactNode }>(children) &&
      children.type !== React.Fragment
        ? children.props.children
        : children;
    const resolvedLeftIcon =
      variant === "back"
        ? (leftIcon ?? <IconArrowLeft aria-hidden="true" />)
        : leftIcon;
    const isLoading = feedbackState === "loading";
    const resolvedDisabled = disabled || isLoading;
    const spinnerClass = getButtonSpinnerClass(size);
    const labels = {
      idle: childContent,
      loading: loadingLabel,
      success: successLabel ?? childContent,
      error: errorLabel ?? childContent,
    } satisfies Record<ButtonFeedbackState, React.ReactNode>;
    const statusesToRender = preserveWidth
      ? (["idle", "loading", "success", "error"] as const)
      : ([displayStatus] as const);
    const hasFeedbackContent = feedbackState !== "idle" || preserveWidth;

    React.useEffect(() => {
      if (feedbackState !== "loading") {
        setDisplayStatus(feedbackState);
        return;
      }

      if (loadingDelayMs <= 0) {
        setDisplayStatus("loading");
        return;
      }

      const timer = window.setTimeout(() => {
        setDisplayStatus("loading");
      }, loadingDelayMs);

      return () => window.clearTimeout(timer);
    }, [feedbackState, loadingDelayMs]);

    function renderStatusContent(
      targetStatus: ButtonFeedbackState,
      isActive: boolean,
    ) {
      if (targetStatus === "loading") {
        if (loadingVisual === "spinner") {
          return isActive ? (
            <>
              <Spinner className={spinnerClass} aria-hidden="true" />
              <span className="sr-only">{labels.loading}</span>
            </>
          ) : (
            <span className={cn("inline-block shrink-0", spinnerClass)} />
          );
        }

        if (loadingVisual === "spinnerText") {
          return (
            <>
              {isActive ? (
                <Spinner className={spinnerClass} aria-hidden="true" />
              ) : (
                <span className={cn("inline-block shrink-0", spinnerClass)} />
              )}
              <span>{labels.loading}</span>
            </>
          );
        }
      }

      return labels[targetStatus];
    }

    const statusContent = preserveWidth ? (
      <span className="inline-grid items-center justify-items-center">
        {statusesToRender.map((targetStatus) => (
          <span
            key={targetStatus}
            aria-hidden={targetStatus !== displayStatus}
            className={cn(
              "inline-flex items-center justify-center gap-2 whitespace-nowrap [grid-area:1/1] transition-opacity",
              targetStatus === displayStatus
                ? "opacity-100"
                : "pointer-events-none opacity-0",
            )}
          >
            {renderStatusContent(targetStatus, targetStatus === displayStatus)}
          </span>
        ))}
      </span>
    ) : (
      renderStatusContent(displayStatus, true)
    );
    const buttonContent = hasFeedbackContent ? statusContent : children;
    const asChildContent =
      asChild && hasFeedbackContent
        ? React.isValidElement<{ children?: React.ReactNode }>(children) &&
          children.type !== React.Fragment
          ? React.cloneElement(children, undefined, statusContent)
          : children
        : children;
    function handleClick(event: React.MouseEvent<HTMLButtonElement>) {
      if (resolvedDisabled) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      onClick?.(event);
    }

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
            disabled: resolvedDisabled,
            leftIcon: Boolean(resolvedLeftIcon),
            rightIcon: Boolean(rightIcon),
            feedbackState,
          },
          customClassName:
            typeof className === "string" ? className : undefined,
        })}
        data-slot="button"
        data-feedback-state={feedbackState}
        aria-busy={isLoading}
        aria-disabled={asChild && resolvedDisabled ? true : undefined}
        disabled={resolvedDisabled}
        className={cn(
          buttonVariants({ variant, size, className }),
          asChild && resolvedDisabled && "pointer-events-none",
        )}
        onClick={handleClick}
        ref={ref}
        {...props}
      >
        {asChild ? (
          asChildContent
        ) : (
          <>
            {renderButtonIcon(resolvedLeftIcon, "button-left-icon", size)}
            {buttonContent}
            {renderButtonIcon(rightIcon, "button-right-icon", size)}
          </>
        )}
      </Comp>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
