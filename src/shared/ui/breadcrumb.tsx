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
    "flex flex-nowrap items-center gap-0 break-normal whitespace-nowrap font-sans text-[length:var(--text-app-top-bar-title)] font-normal leading-[length:var(--text-app-top-bar-title-leading)] tracking-normal text-foreground",
};

const breadcrumbTopBarToneClassNames: Record<BreadcrumbTopBarTone, string> = {
  title: "text-foreground",
  current: "text-muted-foreground",
};

const breadcrumbTopBarToneTransitionClassName =
  "motion-safe:transition-[color,opacity] motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)]";

const breadcrumbTopBarInteractiveClassName =
  "hover:opacity-[var(--app-top-bar-control-hover-opacity)]";

const breadcrumbTopBarEnterClassName =
  "motion-safe:animate-in motion-safe:fade-in-0 motion-reduce:animate-none";
const breadcrumbTopBarTextClipClassName = "py-1 -my-1";

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
          ? cn(
              breadcrumbTopBarToneClassNames[tone],
              breadcrumbTopBarInteractiveClassName,
            )
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
  className,
  items,
  listClassName,
  pageProps,
  variant = "default",
}: {
  className?: string;
  items: BreadcrumbTrailItem[];
  listClassName?: string;
  pageProps?: BreadcrumbPagePassthroughProps;
  variant?: BreadcrumbListVariant;
}) {
  const { className: pageClassName, ...restPageProps } = pageProps ?? {};

  return (
    <Breadcrumb className={className}>
      <BreadcrumbList variant={variant} className={listClassName}>
        {items.map((item, index) => {
          const isFirst = index === 0;
          const isLast = index === items.length - 1;
          const isClickable = Boolean(item.onClick) && !isLast;
          const topBarTone: BreadcrumbTopBarTone =
            isLast && !isFirst ? "current" : "title";
          const topBarItemClassName =
            variant === "top-bar"
              ? cn(
                  "min-w-0",
                  isLast ? "shrink" : "shrink-0",
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
                      variant === "top-bar"
                        ? cn(
                            "block min-w-0 truncate text-inherit",
                            breadcrumbTopBarTextClipClassName,
                          )
                        : undefined
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
                      variant === "top-bar" &&
                        cn(
                          "block min-w-0 truncate text-inherit",
                          breadcrumbTopBarTextClipClassName,
                        ),
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
