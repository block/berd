import type { SVGProps } from "react";

import { cn } from "@/shared/lib/cn";
import { DEFAULT_PROJECT_COLOR } from "../lib/projectDefaults";
import { pillCssColor } from "../lib/pillTones";

const VIEW_BOX = "0 0 13 15";
/** Slightly larger than nav icons (16px) so the cube reads clearly in project rows. */
export const PROJECT_GLYPH_ICON_CLASS = "size-[18px] shrink-0";
/** Fold lines on the filled cube; theme token (white in light, black in dark). */
const CUBE_FOLD_STROKE = "var(--project-glyph-fold-stroke)";
const CUBE_FOLD_STROKE_WIDTH = 0.75;

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

type DefaultProjectGlyphIconProps = Omit<SVGProps<SVGSVGElement>, "color"> & {
  color?: string | null;
  projectId?: string;
};

/** Tabler-derived default project glyph; faces fill with the project color. */
export function DefaultProjectGlyphIcon({
  color,
  projectId,
  className,
  style,
  ...props
}: DefaultProjectGlyphIconProps) {
  const resolvedColor = resolveProjectColor(color);

  return (
    <svg
      viewBox={VIEW_BOX}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="presentation"
      aria-hidden="true"
      focusable="false"
      data-project-color-swatch={projectId}
      className={cn(PROJECT_GLYPH_ICON_CLASS, className)}
      style={{
        color: resolvedColor,
        ...style,
      }}
      {...props}
    >
      <path
        d="M10.9998 9.52576V5.3592C10.9996 5.17654 10.9513 4.99713 10.8599 4.83899C10.7685 4.68084 10.6371 4.54952 10.4789 4.45818L6.8332 2.3749C6.67485 2.28348 6.49522 2.23535 6.31238 2.23535C6.12953 2.23535 5.94991 2.28348 5.79156 2.3749L2.14582 4.45818C1.98763 4.54952 1.85623 4.68084 1.76482 4.83899C1.67341 4.99713 1.62519 5.17654 1.625 5.3592V9.52576C1.62519 9.70843 1.67341 9.88783 1.76482 10.046C1.85623 10.2041 1.98763 10.3354 2.14582 10.4268L5.79156 12.5101C5.94991 12.6015 6.12953 12.6496 6.31238 12.6496C6.49522 12.6496 6.67485 12.6015 6.8332 12.5101L10.4789 10.4268C10.6371 10.3354 10.7685 10.2041 10.8599 10.046C10.9513 9.88783 10.9996 9.70843 10.9998 9.52576Z"
        fill="currentColor"
      />
      <path
        d="M1.76562 4.81738L6.31238 7.44752L10.8591 4.81738"
        fill="none"
        stroke={CUBE_FOLD_STROKE}
        strokeWidth={CUBE_FOLD_STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6.3125 12.6922V7.44238"
        fill="none"
        stroke={CUBE_FOLD_STROKE}
        strokeWidth={CUBE_FOLD_STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
