/**
 * In-app variant of the Berd loader used for session activity (left nav,
 * responding pill). Unlike the startup `berd-loader.tsx` (which morphs the
 * whole mark), this renders the settled Berd mark and only spins the diamond
 * nose/beak cutout with an ease-in/ease-out rotation, then rests.
 *
 * Tunable values live in the SPIN_* constants below.
 */
import { useId, type ComponentProps } from "react";

import { cn } from "@/shared/lib/cn";
import { BERD_LOADER_INLINE_LOOP_MS } from "@/shared/ui/berd-loader-timing";

/** Degrees the nose rotates each loop. 360 reads as one full spin. */
const SPIN_DEGREES = 360;
/** Fraction of the loop spent spinning; the remainder is a rest hold. */
const SPIN_PORTION = 0.9;
/** cubic-bezier control points for the spin (ease-in and ease-out). */
const SPIN_EASE = "0.43 0.12 0.45 0.89";
/** Rotation center of the diamond nose cutout in viewBox coordinates. */
const NOSE_CENTER = "233 157";

const DURATION = `${BERD_LOADER_INLINE_LOOP_MS / 1000}s`;
const HOLD_EASE = "0 0 1 1";

// Keyframes: an eased spin (0 → SPIN_PORTION) followed by a linear rest hold
// (SPIN_PORTION → 1). At SPIN_PORTION >= 1 there is no rest, so the hold
// keyframe is dropped — SMIL requires keyTimes to be strictly increasing, and
// a degenerate "0;1;1" would silently disable the animation.
const SPIN_IS_CONTINUOUS = SPIN_PORTION >= 1;
const SPIN_KEY_TIMES = SPIN_IS_CONTINUOUS ? "0;1" : `0;${SPIN_PORTION};1`;
const SPIN_KEY_SPLINES = SPIN_IS_CONTINUOUS
  ? SPIN_EASE
  : `${SPIN_EASE};${HOLD_EASE}`;
const SPIN_VALUES = SPIN_IS_CONTINUOUS
  ? `0 ${NOSE_CENTER};${SPIN_DEGREES} ${NOSE_CENTER}`
  : `0 ${NOSE_CENTER};${SPIN_DEGREES} ${NOSE_CENTER};${SPIN_DEGREES} ${NOSE_CENTER}`;

const ROUNDED_DIAMOND_PATH =
  "M 236 99 L 293 154 Q 296 157 293 160 L 236 215 Q 233 218 230 215 L 173 160 Q 170 157 173 154 L 230 99 Q 233 96 236 99 Z";

function idPart(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "") || "berd";
}

export interface BerdLoaderInlineProps extends ComponentProps<"svg"> {
  /** When false, renders the settled Berd mark without the nose spin. */
  animated?: boolean;
  /**
   * When true, marks the loader as purely decorative:
   * sets `role="none"`, `aria-hidden="true"`, and removes the label.
   */
  decorative?: boolean;
  /** Width and height of the rendered SVG box in CSS pixels. */
  size?: number;
}

function BerdLoaderInline({
  "aria-hidden": ariaHidden,
  "aria-label": ariaLabel,
  animated = true,
  className,
  color,
  decorative = false,
  height,
  role,
  size = 70,
  style,
  width,
  ...rest
}: BerdLoaderInlineProps) {
  const maskId = `berd-loader-inline-v2-${idPart(useId())}`;
  const resolvedRole = role ?? (decorative ? "none" : "img");
  const resolvedAriaHidden = ariaHidden ?? (decorative ? true : undefined);
  const resolvedAriaLabel = ariaLabel ?? (decorative ? undefined : "Loading");

  return (
    <svg
      aria-hidden={resolvedAriaHidden}
      aria-label={resolvedAriaLabel}
      className={cn("block shrink-0", className)}
      data-slot="berd-loader-inline"
      fill="currentColor"
      height={height ?? size}
      role={resolvedRole}
      style={{
        color,
        inlineSize: width ?? size,
        blockSize: height ?? size,
        ...style,
      }}
      viewBox="116 38 234 234"
      width={width ?? size}
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <defs>
        <mask
          id={maskId}
          x="0"
          y="0"
          width="466"
          height="309"
          maskUnits="userSpaceOnUse"
          maskContentUnits="userSpaceOnUse"
        >
          <rect x="0" y="0" width="466" height="309" fill="#fff" />
          <path d={ROUNDED_DIAMOND_PATH} fill="#000">
            {animated ? (
              <animateTransform
                attributeName="transform"
                type="rotate"
                begin="0s"
                calcMode="spline"
                dur={DURATION}
                keySplines={SPIN_KEY_SPLINES}
                keyTimes={SPIN_KEY_TIMES}
                repeatCount="indefinite"
                values={SPIN_VALUES}
              />
            ) : null}
          </path>
          <ellipse cx="166" cy="90" rx="18.5" ry="18.5" fill="#000" />
          <ellipse cx="300" cy="90" rx="18.5" ry="18.5" fill="#000" />
        </mask>
      </defs>
      <g mask={`url(#${maskId})`}>
        <rect x="128" y="50" width="210" height="210" rx="34" />
      </g>
    </svg>
  );
}

export { BerdLoaderInline };
