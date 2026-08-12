import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

interface SettingsSectionsProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

/** Groups peer settings sections with the standard 44px vertical rhythm. */
export function SettingsSections({
  children,
  className,
  ...props
}: SettingsSectionsProps) {
  return (
    <div
      data-slot="settings-sections"
      className={cn("space-y-11", className)}
      {...props}
    >
      {children}
    </div>
  );
}

interface SettingsSectionProps
  extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  children: ReactNode;
  titleId?: string;
  contentClassName?: string;
}

/**
 * A settings-page section with the shared H2 treatment and row spacing.
 * Section titles intentionally own their typography so feature pages cannot
 * drift in size or weight.
 */
export function SettingsSection({
  title,
  children,
  titleId,
  className,
  contentClassName,
  ...props
}: SettingsSectionProps) {
  return (
    <section
      data-slot="settings-section"
      aria-labelledby={title ? titleId : undefined}
      className={cn("space-y-3", className)}
      {...props}
    >
      {title ? (
        <h2
          id={titleId}
          data-slot="settings-section-title"
          className="font-display text-base font-medium tracking-tight text-foreground"
        >
          {title}
        </h2>
      ) : null}
      <div
        data-slot="settings-section-content"
        className={cn("divide-y divide-border", contentClassName)}
      >
        {children}
      </div>
    </section>
  );
}
