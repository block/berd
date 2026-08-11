import { useState, type ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { BottomFade } from "./BottomFade";
import { TopFade } from "./TopFade";
import { MainPanelLayout } from "./MainPanelLayout";

interface ShellProps {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  contentWidth?: "default" | "narrow" | "full";
  contentAlign?: "top" | "center";
  showBottomFade?: boolean;
  showTopFade?: boolean;
}

const SHELL_WIDTH_CLASSES = {
  narrow: "max-w-3xl",
  default: "max-w-5xl",
  full: "max-w-none",
} as const;

interface PageHeaderProps {
  eyebrow?: ReactNode;
  title?: ReactNode;
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
  contentAlign = "top",
  showBottomFade = true,
  showTopFade = false,
}: ShellProps) {
  return (
    <PageScrollFrame
      className={className}
      contentClassName={contentClassName}
      contentWidth={contentWidth}
      contentAlign={contentAlign}
      showBottomFade={showBottomFade}
      showTopFade={showTopFade}
      minContentHeight
    >
      {children}
    </PageScrollFrame>
  );
}

export function DetailPageShell({
  children,
  className,
  contentClassName,
  contentWidth = "default",
  showBottomFade = true,
}: ShellProps) {
  return (
    <PageScrollFrame
      className={className}
      contentClassName={contentClassName}
      contentWidth={contentWidth}
      showBottomFade={showBottomFade}
    >
      {children}
    </PageScrollFrame>
  );
}

function PageScrollFrame({
  children,
  className,
  contentClassName,
  contentWidth = "default",
  contentAlign = "top",
  showBottomFade = true,
  showTopFade = false,
  minContentHeight = false,
}: ShellProps & { minContentHeight?: boolean }) {
  const widthClassName = SHELL_WIDTH_CLASSES[contentWidth];
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(
    null,
  );

  return (
    <MainPanelLayout className={cn("relative", className)}>
      {showTopFade ? (
        <TopFade
          scrollElement={scrollElement}
          className="absolute inset-x-0 top-0 z-10"
        />
      ) : null}
      <div
        ref={setScrollElement}
        className="min-h-0 flex-1 overflow-y-scroll [scrollbar-gutter:stable]"
      >
        <div
          className={cn(
            "mx-auto flex w-full flex-col px-6 pt-8 page-transition",
            minContentHeight && "min-h-full",
            showBottomFade ? "pb-app-page-bottom" : "pb-8",
            widthClassName,
          )}
        >
          <div
            className={cn(
              "flex w-full flex-col gap-8",
              contentAlign === "center" && "my-auto",
              contentClassName,
            )}
          >
            {children}
          </div>
        </div>
      </div>
      {showBottomFade ? (
        <BottomFade
          scrollElement={scrollElement}
          className="absolute inset-x-0 bottom-0 z-10"
        />
      ) : null}
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
        {title ? (
          <TitleElement className={cn(titleVariantClassName, titleClassName)}>
            {title}
          </TitleElement>
        ) : null}
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
