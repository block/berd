import { useId, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

export interface SettingsRowSlotContext {
  labelId: string;
  descriptionId?: string;
}

interface SettingsRowProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  label: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  /** Right-side action slot. JSX children are accepted as its shorthand. */
  action?: ReactNode | ((context: SettingsRowSlotContext) => ReactNode);
  children?: ReactNode;
  details?: ReactNode | ((context: SettingsRowSlotContext) => ReactNode);
  align?: "center" | "start";
  layout?: "inline" | "stacked" | "responsive";
  density?: "default" | "compact";
  labelId?: string;
  descriptionId?: string;
  descriptionClassName?: string;
  actionClassName?: string;
  detailsClassName?: string;
}

/**
 * A non-interactive settings row with flexible leading, action, and details
 * slots. Interactive behavior belongs to the controls placed in those slots,
 * never to the row itself.
 */
export function SettingsRow({
  label,
  description,
  leading,
  action,
  children,
  details,
  align = "center",
  layout = "inline",
  density = "default",
  labelId: providedLabelId,
  descriptionId: providedDescriptionId,
  descriptionClassName,
  actionClassName,
  detailsClassName,
  className,
  ...props
}: SettingsRowProps) {
  const generatedId = useId();
  const labelId = providedLabelId ?? `${generatedId}-label`;
  const descriptionId = description
    ? (providedDescriptionId ?? `${generatedId}-description`)
    : undefined;
  const context = { labelId, descriptionId };
  const actionSlot = action ?? children;
  const renderedAction =
    typeof actionSlot === "function" ? actionSlot(context) : actionSlot;
  const renderedDetails =
    typeof details === "function" ? details(context) : details;

  return (
    <div
      data-slot="settings-row"
      className={cn(
        "min-w-0 pr-4",
        density === "default" ? "py-4" : "py-2.5 pr-3.5",
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          "flex min-w-0 gap-4",
          align === "center" ? "items-center" : "items-start",
          layout === "stacked" && "flex-col items-stretch gap-3",
          layout === "responsive" &&
            "flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:gap-4",
        )}
      >
        {leading ? (
          <div data-slot="settings-row-leading" className="shrink-0">
            {leading}
          </div>
        ) : null}
        <div data-slot="settings-row-content" className="min-w-0 flex-1">
          <div
            id={labelId}
            data-slot="settings-row-label"
            className="text-sm font-normal! [&_*]:font-normal!"
          >
            {label}
          </div>
          {description ? (
            <div
              id={descriptionId}
              data-slot="settings-row-description"
              className={cn(
                "mt-0.5 text-xs text-muted-foreground",
                descriptionClassName,
              )}
            >
              {description}
            </div>
          ) : null}
        </div>
        {renderedAction ? (
          <div
            data-slot="settings-row-action"
            className={cn(
              "min-w-0 shrink-0",
              layout === "stacked" && "w-full",
              layout === "responsive" && "w-full sm:w-auto",
              actionClassName,
            )}
          >
            {renderedAction}
          </div>
        ) : null}
      </div>
      {renderedDetails ? (
        <div
          data-slot="settings-row-details"
          className={cn("mt-2 min-w-0", detailsClassName)}
        >
          {renderedDetails}
        </div>
      ) : null}
    </div>
  );
}
