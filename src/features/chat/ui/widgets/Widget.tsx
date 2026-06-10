import type { ReactNode } from "react";
import { IconChevronDown } from "@tabler/icons-react";
import { cn } from "@/shared/lib/cn";
import { SIDEBAR_GROUP_LABEL_TEXT_CLASS } from "@/shared/ui/sidebar-tokens";

interface WidgetProps {
  title: ReactNode;
  icon: ReactNode;
  action?: ReactNode;
  flush?: boolean;
  isOpen?: boolean;
  onToggleOpen?: () => void;
  children: ReactNode;
}

const SECTION_HEADER_TEXT_CLASS = cn(
  SIDEBAR_GROUP_LABEL_TEXT_CLASS,
  "min-w-0 truncate text-muted-foreground",
);

export function Widget({
  title,
  icon,
  action,
  flush,
  isOpen = true,
  onToggleOpen,
  children,
}: WidgetProps) {
  const headerTitle = (
    <>
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className={SECTION_HEADER_TEXT_CLASS}>{title}</span>
      {onToggleOpen ? (
        <IconChevronDown
          className={cn(
            "size-[1em] shrink-0 text-muted-foreground transition-transform duration-150",
            !isOpen && "-rotate-90",
          )}
        />
      ) : null}
    </>
  );

  return (
    <section className="w-full pb-3 pt-4 first:pt-3 last:pb-0">
      <div className="px-4">
        <div className="flex min-h-6 items-center justify-between gap-2">
          {onToggleOpen ? (
            <button
              type="button"
              onClick={onToggleOpen}
              aria-expanded={isOpen}
              className={cn(
                "flex min-w-0 flex-1 items-center gap-0.5 rounded-sm py-1 text-left transition-colors hover:text-foreground",
                SECTION_HEADER_TEXT_CLASS,
              )}
            >
              {headerTitle}
            </button>
          ) : (
            <div
              className={cn(
                "flex min-w-0 flex-1 items-center gap-0.5",
                SECTION_HEADER_TEXT_CLASS,
              )}
            >
              {headerTitle}
            </div>
          )}
          {action && <div className="shrink-0">{action}</div>}
        </div>
        {isOpen && !flush && (
          <div className="pt-2 text-sm font-normal text-foreground">
            {children}
          </div>
        )}
      </div>
      {isOpen && flush ? (
        <div className="pt-1.5 font-normal">{children}</div>
      ) : null}
    </section>
  );
}
