import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/shared/lib/cn";
import { getDesignSystemMetadata } from "@/shared/ui/design-system/metadata";
import { Spinner } from "@/shared/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

const buttonVariants = cva(
  "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-full text-left text-sm font-normal transition-colors disabled:pointer-events-none disabled:opacity-50 data-[disabled=true]:opacity-50 aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary:
          "bg-primary text-primary-foreground shadow-none hover:bg-primary/90",
        outline:
          "border border-input bg-background shadow-none hover:bg-accent hover:text-accent-foreground",
        subtle:
          "bg-accent text-accent-foreground shadow-none hover:bg-accent-hover",
        alert:
          "border border-current/30 bg-transparent font-medium text-current shadow-none hover:bg-current/10 hover:text-current",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        xxs: "h-6 gap-1.5 px-2 text-[11px] [&_svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-3",
        xs: "h-7 px-2.5 text-xs [&_svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-3",
        default:
          "h-9 px-4 py-2 [&_svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-3.5",
        sm: "h-8 px-3 text-xs [&_svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-3",
        compact:
          "h-8 px-3 text-sm [&_svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-3",
        lg: "h-10 px-8 [&_svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-4",
        icon: "h-9 w-9 [&_svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-4",
        "icon-xxs":
          "h-6 w-6 [&_svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-3.5",
        "icon-xs":
          "h-7 w-7 [&_svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-3",
        "icon-sm":
          "h-8 w-8 [&_svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-3.5",
        "icon-top-bar":
          "size-[var(--spacing-app-top-bar-control)] [&_svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-[length:var(--text-app-top-bar-icon)]",
        "icon-pill-sm":
          "h-8 w-10 [&_svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-4",
        "icon-lg":
          "h-10 w-10 [&_svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-5",
      },
      destructive: {
        true: "",
        false: "",
      },
      flush: {
        true: "",
        false: "",
      },
    },
    compoundVariants: [
      {
        variant: "primary",
        destructive: true,
        className:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
      },
      {
        variant: "outline",
        destructive: true,
        className:
          "border-destructive/30 text-destructive hover:border-destructive/40 hover:bg-destructive/8 hover:text-destructive",
      },
      {
        variant: "ghost",
        destructive: true,
        className:
          "text-destructive hover:bg-destructive/10 hover:text-destructive",
      },
      {
        variant: "subtle",
        destructive: true,
        className:
          "bg-destructive/10 text-destructive hover:bg-destructive/16 hover:text-destructive",
      },
      {
        variant: "ghost",
        flush: true,
        className:
          "bg-transparent px-0 text-muted-foreground hover:bg-transparent hover:text-foreground active:bg-transparent active:text-foreground data-[state=open]:bg-transparent data-[state=open]:text-foreground aria-expanded:bg-transparent",
      },
      {
        variant: "link",
        className: "h-auto p-0",
      },
      {
        variant: "ghost",
        size: "icon-xxs",
        className:
          "bg-transparent text-muted-foreground hover:bg-transparent hover:text-foreground active:bg-transparent data-[state=open]:text-foreground aria-expanded:text-foreground",
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
      variant: "primary",
      size: "default",
      destructive: false,
      flush: false,
    },
  },
);

const buttonIconSizeClasses = {
  xxs: "size-3",
  xs: "size-3",
  default: "size-3.5",
  sm: "size-3",
  compact: "size-3",
  lg: "size-4",
  icon: "size-4",
  "icon-xxs": "size-3.5",
  "icon-xs": "size-3",
  "icon-sm": "size-3.5",
  "icon-top-bar": "size-[length:var(--text-app-top-bar-icon)]",
  "icon-pill-sm": "size-4",
  "icon-lg": "size-5",
} satisfies Record<
  NonNullable<VariantProps<typeof buttonVariants>["size"]>,
  string
>;

type ButtonSize = VariantProps<typeof buttonVariants>["size"];

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
    case "compact":
    case "icon-xxs":
    case "icon-xs":
      return "size-3";
    case "lg":
    case "icon-lg":
      return "size-4";
    default:
      return "size-3.5";
  }
}

// Comparable key for a feedback label, used to detect a loading label that
// repeats a resting label (see the duplicateStatusLabels note in Button).
//
// Only plain text is comparable: element labels return null, so a call site
// passing `<span>Save</span>` as children alongside `loadingLabel="Save"` gets
// no protection. That is a deliberate limit — reaching into arbitrary element
// trees to extract text is more fragile than the artifact is costly, and every
// preserveWidth call site in the app passes strings.
//
// Intentionally not a JSDoc block: the design-system manifest publishes the
// first module-scope doc block as the public description for Button, and this
// private helper should not own that. Avoid apostrophes here too — the manifest
// scanner matches quoted spans across raw text, so a stray quote character
// swallows nearby source and lands junk entries in the generated manifest.
function getButtonLabelKey(label: React.ReactNode) {
  return typeof label === "string" || typeof label === "number"
    ? String(label)
    : null;
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

function isIconOnlyButtonSize(
  size: ButtonSize,
): size is Extract<NonNullable<ButtonSize>, `icon${string}`> {
  return typeof size === "string" && size.startsWith("icon");
}

function renderButtonIcon(
  icon: React.ReactNode,
  slot: "button-left-icon" | "button-right-icon",
  size: ButtonSize,
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

function renderIconOnlyButtonChildren(
  children: React.ReactNode,
  size: ButtonSize,
) {
  if (!isIconOnlyButtonSize(size)) {
    return children;
  }

  const iconSizeClass = buttonIconSizeClasses[size];
  return React.isValidElement<ButtonIconProps>(children) &&
    children.type !== React.Fragment &&
    !hasExplicitIconDimensions(children)
    ? React.cloneElement(children, {
        className: cn(iconSizeClass, children.props.className),
      })
    : children;
}

type ButtonCvaProps = VariantProps<typeof buttonVariants>;
type ButtonEmphasis = NonNullable<ButtonCvaProps["variant"]>;

/** Variants that support the destructive intent flag. */
const DESTRUCTIVE_EMPHASES = ["primary", "outline", "subtle", "ghost"] as const;

export type ButtonDestructiveEmphasis = (typeof DESTRUCTIVE_EMPHASES)[number];

export function isButtonDestructiveEmphasis(
  variant: ButtonEmphasis,
): variant is ButtonDestructiveEmphasis {
  return (DESTRUCTIVE_EMPHASES as readonly string[]).includes(variant);
}

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  Omit<ButtonCvaProps, "destructive" | "flush"> & {
    /**
     * Danger intent. Recolors the emphasis recipe with destructive tokens:
     * primary = red fill, outline = red border + red text, subtle = red
     * tinted fill, ghost = red text with a destructive/10 hover tint. Only
     * meaningful on primary, outline, subtle, and ghost; other variants
     * ignore it (dev builds warn).
     */
    destructive?: boolean;
    /**
     * Inline geometry for ghost buttons that sit flush with surrounding
     * content (list section actions, inline "show more" affordances).
     * Removes horizontal padding, rests at muted-foreground, and raises the
     * label on hover instead of painting a background pill. Only meaningful
     * on ghost; other variants ignore it (dev builds warn).
     */
    flush?: boolean;
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
    /**
     * Visible product tooltip for the control. Prefer this over the native
     * `title` attribute so button help has consistent styling and behavior.
     */
    tooltip?: React.ReactNode;
    tooltipSide?: React.ComponentProps<typeof TooltipContent>["side"];
  };

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      destructive,
      flush,
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
      tooltip,
      tooltipSide = "top",
      disabled,
      onClick,
      "aria-disabled": ariaDisabled,
      ...props
    },
    ref,
  ) => {
    const [displayStatus, setDisplayStatus] =
      React.useState<ButtonFeedbackState>(feedbackState);
    const resolvedEmphasis = variant ?? "primary";
    const resolvedDestructive = Boolean(
      destructive && isButtonDestructiveEmphasis(resolvedEmphasis),
    );
    if (import.meta.env.DEV && destructive && !resolvedDestructive) {
      console.warn(
        `Button: the destructive flag is only supported on ${DESTRUCTIVE_EMPHASES.join(
          ", ",
        )} variants; it is ignored on variant="${resolvedEmphasis}".`,
      );
    }
    const resolvedFlush = Boolean(flush && resolvedEmphasis === "ghost");
    if (import.meta.env.DEV && flush && !resolvedFlush) {
      console.warn(
        `Button: the flush flag is only supported on the ghost variant; it is ignored on variant="${resolvedEmphasis}".`,
      );
    }
    const Comp = asChild ? Slot : "button";
    const renderedChildren = asChild
      ? children
      : renderIconOnlyButtonChildren(children, size);
    const childContent =
      asChild &&
      React.isValidElement<{ children?: React.ReactNode }>(children) &&
      children.type !== React.Fragment
        ? children.props.children
        : renderedChildren;
    const resolvedLeftIcon = leftIcon;
    const isLoading = feedbackState === "loading";
    const externallyAriaDisabled =
      ariaDisabled === true || ariaDisabled === "true";
    const resolvedDisabled = disabled || isLoading;
    const disabledTooltipLabel =
      Object.entries(props).find(([key]) => key.endsWith("-label"))?.[1] ??
      (typeof tooltip === "string" ? tooltip : undefined);
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
    /**
     * preserveWidth stacks every feedback layer in one centered grid cell and
     * cross-fades them with transition-opacity. Identical labels alone are
     * harmless — same geometry means they superimpose pixel-perfectly. The
     * artifact needs a *width* mismatch: spinnerText gives the loading layer a
     * spinner slot + gap, so centering shifts its text sideways. Fading that
     * against an identical string paints two offset copies at once, reading as
     * garbled text like "Try Againin" (BOT-1466).
     *
     * So this is deliberately scoped to the only combination that can garble:
     * a spinner-plus-text loading layer whose label repeats another layer's.
     * Note success/error fall back to children, so a broader duplicate check
     * would match nearly every preserveWidth button and needlessly kill the
     * fade for legitimately distinct labels.
     */
    const loadingLabelKey = getButtonLabelKey(labels.loading);
    const duplicateStatusLabels =
      preserveWidth &&
      loadingVisual === "spinnerText" &&
      loadingLabelKey !== null &&
      (["idle", "success", "error"] as const).some(
        (status) => getButtonLabelKey(labels[status]) === loadingLabelKey,
      );

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
              "inline-flex items-center justify-center gap-2 whitespace-nowrap [grid-area:1/1]",
              !duplicateStatusLabels && "transition-opacity",
              targetStatus === displayStatus && "opacity-100",
              targetStatus !== displayStatus && "pointer-events-none opacity-0",
              targetStatus !== displayStatus &&
                duplicateStatusLabels &&
                "invisible",
            )}
          >
            {renderStatusContent(targetStatus, targetStatus === displayStatus)}
          </span>
        ))}
      </span>
    ) : (
      renderStatusContent(displayStatus, true)
    );
    const buttonContent = hasFeedbackContent ? statusContent : renderedChildren;
    const asChildContent =
      asChild && hasFeedbackContent
        ? React.isValidElement<{ children?: React.ReactNode }>(children) &&
          children.type !== React.Fragment
          ? React.cloneElement(children, undefined, statusContent)
          : children
        : children;
    function handleClick(event: React.MouseEvent<HTMLButtonElement>) {
      if (resolvedDisabled || externallyAriaDisabled) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      onClick?.(event);
    }

    const button = (
      <Comp
        {...getDesignSystemMetadata({
          component: "Button",
          slot: "button",
          source: "src/shared/ui/button.tsx",
          variant: variant ?? "primary",
          size: size ?? "default",
          props: {
            destructive: resolvedDestructive,
            flush: resolvedFlush,
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
        aria-disabled={
          asChild && resolvedDisabled
            ? true
            : externallyAriaDisabled
              ? true
              : undefined
        }
        disabled={resolvedDisabled}
        className={cn(
          buttonVariants({
            variant,
            size,
            destructive: resolvedDestructive,
            flush: resolvedFlush,
            className,
          }),
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

    if (tooltip === undefined || tooltip === null || tooltip === "") {
      return button;
    }

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {resolvedDisabled ? (
            <span
              role="group"
              data-button-tooltip-trigger=""
              className="inline-flex"
              tabIndex={props.tabIndex ?? 0}
              aria-disabled="true"
              aria-label={disabledTooltipLabel}
            >
              {button}
            </span>
          ) : (
            button
          )}
        </TooltipTrigger>
        <TooltipContent side={tooltipSide}>{tooltip}</TooltipContent>
      </Tooltip>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
