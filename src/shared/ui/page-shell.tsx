import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { BottomFade } from "./BottomFade";
import { MainPanelLayout } from "./MainPanelLayout";

interface ShellProps {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  contentWidth?: "default" | "narrow" | "full";
  showBottomFade?: boolean;
}

const SHELL_WIDTH_CLASSES = {
  narrow: "max-w-3xl",
  default: "max-w-5xl",
  full: "max-w-none",
} as const;

interface PageHeaderProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  titleElement?: "h1" | "div";
  variant?: "default" | "detail";
  actionsPlacement?: "end" | "below";
  className?: string;
  eyebrowClassName?: string;
  titleClassName?: string;
  descriptionClassName?: string;
  actionsClassName?: string;
}

export function PageShell({
  children,
  className,
  contentClassName,
  contentWidth = "default",
  showBottomFade = true,
}: ShellProps) {
  const widthClassName = SHELL_WIDTH_CLASSES[contentWidth];

  return (
    <MainPanelLayout className={className}>
      <div className="min-h-0 flex-1 overflow-y-scroll [scrollbar-gutter:stable]">
        <div
          className={cn(
            "mx-auto flex w-full flex-col px-6 pt-8 page-transition",
            showBottomFade ? "pb-app-page-bottom" : "pb-8",
            widthClassName,
          )}
        >
          <div className={cn("flex w-full flex-col gap-8", contentClassName)}>
            {children}
          </div>
          {showBottomFade ? <BottomFade className="-mt-64" /> : null}
        </div>
      </div>
    </MainPanelLayout>
  );
}

export function DetailPageShell({
  children,
  className,
  contentClassName,
  contentWidth = "default",
  showBottomFade = true,
}: ShellProps) {
  const widthClassName = SHELL_WIDTH_CLASSES[contentWidth];

  return (
    <MainPanelLayout className={className}>
      <div className="min-h-0 flex-1 overflow-y-scroll [scrollbar-gutter:stable]">
        <div
          className={cn(
            "mx-auto flex w-full flex-col px-6 pt-8 page-transition",
            showBottomFade ? "pb-app-page-bottom" : "pb-8",
            widthClassName,
          )}
        >
          <div className={cn("flex w-full flex-col gap-8", contentClassName)}>
            {children}
          </div>
          {showBottomFade ? <BottomFade className="-mt-64" /> : null}
        </div>
      </div>
    </MainPanelLayout>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  titleElement = "h1",
  variant = "default",
  actionsPlacement = "end",
  className,
  eyebrowClassName,
  titleClassName,
  descriptionClassName,
  actionsClassName,
}: PageHeaderProps) {
  const TitleElement = titleElement;
  const actionsBelow = actionsPlacement === "below";
  const titleVariantClassName =
    variant === "detail"
      ? "font-display text-2xl font-normal tracking-tight text-foreground"
      : "text-xl tracking-tight";

  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-4",
        actionsBelow && "flex-col items-start justify-start",
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow ? (
          <div className={cn("mb-3", eyebrowClassName)}>{eyebrow}</div>
        ) : null}
        <TitleElement className={cn(titleVariantClassName, titleClassName)}>
          {title}
        </TitleElement>
        {description ? (
          <p
            className={cn(
              "mt-1 text-sm font-light text-muted-foreground",
              descriptionClassName,
            )}
          >
            {description}
          </p>
        ) : null}
        {actions && actionsBelow ? (
          <div
            className={cn(
              "mt-4 flex flex-wrap items-center gap-1",
              actionsClassName,
            )}
          >
            {actions}
          </div>
        ) : null}
      </div>
      {actions && !actionsBelow ? (
        <div className={cn("flex items-start gap-2", actionsClassName)}>
          {actions}
        </div>
      ) : null}
    </div>
  );
}

export function FilterRow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {children}
    </div>
  );
}
