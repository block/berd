import { Fragment } from "react";
import type * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { ChevronRight, MoreHorizontal } from "lucide-react";

import { cn } from "@/shared/lib/cn";

function Breadcrumb({ ...props }: React.ComponentProps<"nav">) {
  return <nav aria-label="breadcrumb" data-slot="breadcrumb" {...props} />;
}

type BreadcrumbListVariant = "default" | "top-bar";
type BreadcrumbTopBarTone = "title" | "current";

export type BreadcrumbTrailItem = {
  id?: string;
  label: string;
  onClick?: () => void;
};

type BreadcrumbPagePassthroughProps = React.ComponentProps<"span"> & {
  [key: string]: unknown;
};

const breadcrumbListVariants: Record<BreadcrumbListVariant, string> = {
  default:
    "text-muted-foreground flex flex-wrap items-center gap-1.5 text-sm break-words sm:gap-2.5",
  "top-bar":
    "flex flex-nowrap items-center gap-0 break-normal whitespace-nowrap font-sans text-[24px] font-light leading-[0.96] tracking-normal text-text-title",
};

const breadcrumbTopBarToneClassNames: Record<BreadcrumbTopBarTone, string> = {
  title: "text-text-title",
  current: "text-text-muted",
};

const breadcrumbTopBarToneTransitionClassName =
  "motion-safe:transition-colors motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)]";

const breadcrumbTopBarEnterClassName =
  "motion-safe:animate-in motion-safe:fade-in-0 motion-reduce:animate-none";

function BreadcrumbList({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"ol"> & {
  variant?: BreadcrumbListVariant;
}) {
  return (
    <ol
      data-slot="breadcrumb-list"
      className={cn(breadcrumbListVariants[variant], className)}
      {...props}
    />
  );
}

function BreadcrumbItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="breadcrumb-item"
      className={cn("inline-flex items-center gap-1.5", className)}
      {...props}
    />
  );
}

function BreadcrumbLink({
  asChild,
  className,
  variant = "default",
  tone = "title",
  ...props
}: React.ComponentProps<"a"> & {
  asChild?: boolean;
  variant?: "default" | "top-bar";
  tone?: BreadcrumbTopBarTone;
}) {
  const Comp = asChild ? Slot : "a";

  return (
    <Comp
      data-slot="breadcrumb-link"
      className={cn(
        variant === "top-bar"
          ? breadcrumbTopBarToneTransitionClassName
          : "transition-colors",
        variant === "top-bar"
          ? cn(breadcrumbTopBarToneClassNames[tone], "hover:text-text-hover")
          : "hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function BreadcrumbPage({
  className,
  variant = "default",
  tone,
  ...props
}: React.ComponentProps<"span"> & {
  variant?: "default" | "top-bar-root" | "top-bar-current";
  tone?: BreadcrumbTopBarTone;
}) {
  const topBarTone =
    tone ?? (variant === "top-bar-current" ? "current" : "title");

  return (
    <span
      data-slot="breadcrumb-page"
      role="link"
      aria-disabled="true"
      aria-current="page"
      className={cn(
        (variant === "top-bar-root" || variant === "top-bar-current") &&
          cn(
            "font-light",
            breadcrumbTopBarToneTransitionClassName,
            breadcrumbTopBarToneClassNames[topBarTone],
          ),
        variant === "default" && "text-foreground font-normal",
        className,
      )}
      {...props}
    />
  );
}

function BreadcrumbSeparator({
  children,
  className,
  variant = "default",
  tone = "current",
  ...props
}: React.ComponentProps<"li"> & {
  variant?: "default" | "top-bar";
  tone?: BreadcrumbTopBarTone;
}) {
  return (
    <li
      data-slot="breadcrumb-separator"
      role="presentation"
      aria-hidden="true"
      className={cn(
        "[&>svg]:size-3.5",
        variant === "top-bar" &&
          cn(
            "mx-1.5",
            breadcrumbTopBarToneTransitionClassName,
            breadcrumbTopBarToneClassNames[tone],
          ),
        className,
      )}
      {...props}
    >
      {children ?? <ChevronRight />}
    </li>
  );
}

function BreadcrumbTrail({
  items,
  pageProps,
  variant = "default",
}: {
  items: BreadcrumbTrailItem[];
  pageProps?: BreadcrumbPagePassthroughProps;
  variant?: BreadcrumbListVariant;
}) {
  const { className: pageClassName, ...restPageProps } = pageProps ?? {};

  return (
    <Breadcrumb>
      <BreadcrumbList variant={variant}>
        {items.map((item, index) => {
          const isFirst = index === 0;
          const isLast = index === items.length - 1;
          const isClickable = Boolean(item.onClick) && !isLast;
          const topBarTone: BreadcrumbTopBarTone =
            isLast && !isFirst ? "current" : "title";
          const topBarItemClassName =
            variant === "top-bar"
              ? cn(
                  breadcrumbTopBarToneTransitionClassName,
                  breadcrumbTopBarToneClassNames[topBarTone],
                  index > 1 && breadcrumbTopBarEnterClassName,
                )
              : undefined;
          const topBarSeparatorClassName =
            variant === "top-bar" && index > 1
              ? breadcrumbTopBarEnterClassName
              : undefined;

          return (
            <Fragment key={item.id ?? item.label}>
              {index > 0 ? (
                <BreadcrumbSeparator
                  variant={variant}
                  tone={topBarTone}
                  className={topBarSeparatorClassName}
                >
                  {variant === "top-bar" ? "/" : undefined}
                </BreadcrumbSeparator>
              ) : null}
              <BreadcrumbItem className={topBarItemClassName}>
                {isClickable ? (
                  <BreadcrumbLink
                    href="#"
                    variant={variant}
                    tone={topBarTone}
                    className={
                      variant === "top-bar" ? "text-inherit" : undefined
                    }
                    onClick={(event) => {
                      event.preventDefault();
                      item.onClick?.();
                    }}
                  >
                    {item.label}
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage
                    {...restPageProps}
                    variant={
                      variant === "top-bar"
                        ? isFirst
                          ? "top-bar-root"
                          : "top-bar-current"
                        : "default"
                    }
                    tone={topBarTone}
                    className={cn(
                      variant === "top-bar" && "text-inherit",
                      pageClassName,
                    )}
                  >
                    {item.label}
                  </BreadcrumbPage>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function BreadcrumbEllipsis({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="breadcrumb-ellipsis"
      role="presentation"
      aria-hidden="true"
      className={cn("flex size-9 items-center justify-center", className)}
      {...props}
    >
      <MoreHorizontal className="size-4" />
      <span className="sr-only">More</span>
    </span>
  );
}

export {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
  BreadcrumbEllipsis,
  BreadcrumbTrail,
};
