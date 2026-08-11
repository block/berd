import { Fragment } from "react";
import type * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { ChevronRight, MoreHorizontal } from "lucide-react";

import { cn } from "@/shared/lib/cn";

function Breadcrumb({ ...props }: React.ComponentProps<"nav">) {
  return <nav aria-label="breadcrumb" data-slot="breadcrumb" {...props} />;
}

type BreadcrumbListVariant = "default" | "top-bar" | "settings";
type BreadcrumbTopBarTone = "title" | "current";

export type BreadcrumbTrailItem = {
  id?: string;
  label: string;
  onClick?: () => void;
};

type BreadcrumbPagePassthroughProps = React.ComponentProps<"span"> & {
  [key: string]: unknown;
};

// Variants that share the "clickable parent / muted-or-not current" trail
// structure (as opposed to the plain "default" list breadcrumb).
const BREADCRUMB_TRAIL_VARIANTS = new Set<BreadcrumbListVariant>([
  "top-bar",
  "settings",
]);

function isTrailVariant(variant: BreadcrumbListVariant): boolean {
  return BREADCRUMB_TRAIL_VARIANTS.has(variant);
}

const breadcrumbListVariants: Record<BreadcrumbListVariant, string> = {
  default:
    "text-muted-foreground flex flex-wrap items-center gap-1.5 text-sm break-words sm:gap-2.5",
  "top-bar":
    "flex flex-nowrap items-center gap-0 break-normal whitespace-nowrap font-sans text-[length:var(--text-app-top-bar-title)] font-normal leading-[length:var(--text-app-top-bar-title-leading)] tracking-normal text-foreground",
  // Used when a breadcrumb trail stands in for a page's own title (e.g. a
  // SettingsPage heading). Deliberately sets no font-size/weight/tracking/
  // color of its own so it inherits the exact typography and position of
  // the surrounding title element - only the tone colors below differ.
  settings: "flex flex-nowrap items-center gap-0 min-w-0",
};

// Horizontal margin around the separator glyph. The settings trail sits
// inline with a page title, so it should read tightly (title / sub-page)
// rather than with the more generous top-bar chrome spacing.
const breadcrumbSeparatorMarginClassNameByVariant: Record<
  "top-bar" | "settings",
  string
> = {
  "top-bar": "mx-1.5",
  settings: "mx-1",
};

// Color mapping differs by variant: the top-bar trail (used for chrome like
// the app TopBar / chat titles) keeps the parent segment full-color and
// mutes the trailing "current" segment. Settings breadcrumbs use the
// opposite, more conventional convention: the clickable parent is muted,
// and the current page reads as normal foreground text.
const breadcrumbToneClassNamesByVariant: Record<
  "top-bar" | "settings",
  Record<BreadcrumbTopBarTone, string>
> = {
  "top-bar": {
    title: "text-foreground",
    current: "text-muted-foreground",
  },
  settings: {
    title: "text-muted-foreground",
    current: "text-foreground",
  },
};

function getBreadcrumbToneClassName(
  variant: BreadcrumbListVariant,
  tone: BreadcrumbTopBarTone,
): string {
  if (variant === "top-bar" || variant === "settings") {
    return breadcrumbToneClassNamesByVariant[variant][tone];
  }
  return "";
}

const breadcrumbTopBarToneTransitionClassName =
  "motion-safe:transition-[color,opacity] motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)]";

const breadcrumbInteractiveClassNamesByVariant: Record<
  "top-bar" | "settings",
  string
> = {
  "top-bar": "hover:opacity-[var(--app-top-bar-control-hover-opacity)]",
  settings: "cursor-pointer hover:text-foreground",
};

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
  variant?: BreadcrumbListVariant;
  tone?: BreadcrumbTopBarTone;
}) {
  const Comp = asChild ? Slot : "a";
  const isTrail = isTrailVariant(variant);

  return (
    <Comp
      data-slot="breadcrumb-link"
      className={cn(
        isTrail ? breadcrumbTopBarToneTransitionClassName : "transition-colors",
        isTrail
          ? cn(
              getBreadcrumbToneClassName(variant, tone),
              breadcrumbInteractiveClassNamesByVariant[
                variant as "top-bar" | "settings"
              ],
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
  tone = "title",
  ...props
}: React.ComponentProps<"span"> & {
  variant?: BreadcrumbListVariant;
  tone?: BreadcrumbTopBarTone;
}) {
  const isTrail = isTrailVariant(variant);

  return (
    <span
      data-slot="breadcrumb-page"
      role="link"
      aria-disabled="true"
      aria-current="page"
      className={cn(
        isTrail &&
          cn(
            breadcrumbTopBarToneTransitionClassName,
            getBreadcrumbToneClassName(variant, tone),
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
  variant?: BreadcrumbListVariant;
  tone?: BreadcrumbTopBarTone;
}) {
  const isTrail = isTrailVariant(variant);
  return (
    <li
      data-slot="breadcrumb-separator"
      role="presentation"
      aria-hidden="true"
      className={cn(
        "[&>svg]:size-3.5",
        isTrail &&
          cn(
            breadcrumbSeparatorMarginClassNameByVariant[
              variant as "top-bar" | "settings"
            ],
            breadcrumbTopBarToneTransitionClassName,
            getBreadcrumbToneClassName(variant, tone),
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

  const isTrail = isTrailVariant(variant);
  const isTopBar = variant === "top-bar";

  return (
    <Breadcrumb className={className}>
      <BreadcrumbList variant={variant} className={listClassName}>
        {items.map((item, index) => {
          const isFirst = index === 0;
          const isLast = index === items.length - 1;
          const isClickable = Boolean(item.onClick) && !isLast;
          const tone: BreadcrumbTopBarTone =
            isLast && !isFirst ? "current" : "title";
          const trailItemClassName = isTrail
            ? cn(
                "min-w-0",
                isLast ? "shrink" : "shrink-0",
                breadcrumbTopBarToneTransitionClassName,
                getBreadcrumbToneClassName(variant, tone),
                isTopBar && index > 1 && breadcrumbTopBarEnterClassName,
              )
            : undefined;
          const trailSeparatorClassName =
            isTopBar && index > 1 ? breadcrumbTopBarEnterClassName : undefined;

          return (
            <Fragment key={item.id ?? item.label}>
              {index > 0 ? (
                <BreadcrumbSeparator
                  variant={variant}
                  tone={tone}
                  className={trailSeparatorClassName}
                >
                  {isTopBar ? "/" : undefined}
                </BreadcrumbSeparator>
              ) : null}
              <BreadcrumbItem className={trailItemClassName}>
                {isClickable ? (
                  <BreadcrumbLink
                    href="#"
                    variant={variant}
                    tone={tone}
                    className={
                      isTrail
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
                    variant={variant}
                    tone={tone}
                    className={cn(
                      isTrail &&
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
