import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { Popover, PopoverAnchor, PopoverContent } from "@/shared/ui/popover";
import {
  HOME_WIDGET_CATALOG,
  HOME_WIDGET_CATEGORIES,
} from "../widgets/catalog";
import type { WidgetCategory } from "../widgets/types";

interface WidgetPickerProps {
  open: boolean;
  x: number;
  y: number;
  onClose: () => void;
  onSelect: (type: string, state?: Record<string, unknown>) => void;
}

export function WidgetPicker({
  open,
  x,
  y,
  onClose,
  onSelect,
}: WidgetPickerProps) {
  const { t } = useTranslation("home");
  const [activeCategory, setActiveCategory] = useState<WidgetCategory | null>(
    null,
  );

  const entriesByCategory = useMemo(
    () =>
      Object.fromEntries(
        HOME_WIDGET_CATEGORIES.map((category) => [
          category,
          HOME_WIDGET_CATALOG.filter(
            (entry) => entry.category === category && entry.Component,
          ),
        ]),
      ) as Record<WidgetCategory, typeof HOME_WIDGET_CATALOG>,
    [],
  );

  const visibleCategories = useMemo(
    () =>
      HOME_WIDGET_CATEGORIES.filter(
        (category) => entriesByCategory[category].length > 0,
      ),
    [entriesByCategory],
  );

  useEffect(() => {
    if (open) {
      setActiveCategory(null);
    }
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <Popover open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <PopoverAnchor asChild>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute size-0"
          style={{ left: x, top: y }}
        />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        side="right"
        sideOffset={10}
        onPointerDownCapture={(event) => event.stopPropagation()}
        onDoubleClickCapture={(event) => event.stopPropagation()}
        onWheelCapture={(event) => event.stopPropagation()}
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="w-36 overflow-visible rounded-chrome border border-border-soft bg-surface-chrome p-1.5 text-foreground backdrop-blur-md"
      >
        <div className="relative">
          <div className="space-y-0.5">
            {visibleCategories.map((category) => (
              <button
                key={category}
                type="button"
                aria-expanded={activeCategory === category}
                aria-haspopup="menu"
                onClick={() => setActiveCategory(category)}
                onFocus={() => setActiveCategory(category)}
                onMouseEnter={() => setActiveCategory(category)}
                className={cn(
                  "flex w-full items-center justify-between rounded-tile px-3 py-2 text-left text-sm transition-colors",
                  activeCategory === category
                    ? "bg-surface-tile"
                    : "hover:bg-surface-tile/50",
                )}
              >
                <span>{t(`widgets.picker.sections.${category}`)}</span>
                <ChevronRight className="size-3.5 text-muted-foreground" />
              </button>
            ))}
          </div>

          {activeCategory !== null &&
          entriesByCategory[activeCategory].length > 0 ? (
            <div
              role="menu"
              className="absolute left-full top-0 ml-2 w-72 rounded-chrome border border-border-soft bg-surface-chrome p-2 backdrop-blur-md"
            >
              <div className="space-y-0.5">
                {entriesByCategory[activeCategory].map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    role="menuitem"
                    onClick={() => onSelect(entry.id)}
                    className="flex w-full items-start gap-3 rounded-tile bg-surface-tile px-3 py-2.5 text-left transition-colors hover:bg-surface-tile/50"
                  >
                    <span className="mt-1 size-2 shrink-0 rounded-full bg-foreground/25" />
                    <span className="min-w-0">
                      <span className="block text-sm text-foreground">
                        {t(entry.labelKey)}
                      </span>
                      {entry.descriptionKey ? (
                        <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                          {t(entry.descriptionKey)}
                        </span>
                      ) : null}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
