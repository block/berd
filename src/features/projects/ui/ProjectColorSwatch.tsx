import { cn } from "@/shared/lib/cn";
import { DEFAULT_PROJECT_COLOR } from "../lib/projectDefaults";
import { pillCssColor } from "../lib/pillTones";

function resolveProjectColor(color?: string | null) {
  const storedColor = color || DEFAULT_PROJECT_COLOR;
  return (
    pillCssColor(storedColor) ??
    (storedColor.startsWith("#")
      ? storedColor
      : pillCssColor(DEFAULT_PROJECT_COLOR)) ??
    undefined
  );
}

export function ProjectColorSwatch({
  color,
  projectId,
  className,
}: {
  color?: string | null;
  projectId?: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-project-color-swatch={projectId}
      className={cn("inline-block size-3 rounded-[3px]", className)}
      style={{ backgroundColor: resolveProjectColor(color) }}
    />
  );
}
