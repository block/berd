import { useId, type ComponentProps } from "react";

import { cn } from "@/shared/lib/cn";
import { BERD_LOADER_LOOP_MS } from "@/shared/ui/berd-loader-timing";

const EASE = ".16 1 .3 1";
const DURATION = `${BERD_LOADER_LOOP_MS / 1000}s`;
const LOOP = "indefinite";

const EMPTY_CUTOUT_PATH =
  "M 233 155 L 233 155 Q 233 155 233 155 L 233 155 Q 233 155 233 155 L 233 155 Q 233 155 233 155 L 233 155 Q 233 155 233 155 Z";
const ROUNDED_CUTOUT_PATH =
  "M 193 111 L 273 111 Q 277 111 277 115 L 277 195 Q 277 199 273 199 L 193 199 Q 189 199 189 195 L 189 115 Q 189 111 193 111 Z";
const ROUNDED_CUTOUT_LARGE_PATH =
  "M 185 103 L 281 103 Q 285 103 285 107 L 285 203 Q 285 207 281 207 L 185 207 Q 181 207 181 203 L 181 107 Q 181 103 185 103 Z";
const ROUNDED_DIAMOND_PATH =
  "M 236 99 L 293 154 Q 296 157 293 160 L 236 215 Q 233 218 230 215 L 173 160 Q 170 157 173 154 L 230 99 Q 233 96 236 99 Z";

type SvgAnimationTiming = readonly [keyTimes: string, values: string];

const TIMINGS = {
  body: {
    opacity: ["0;0.0291;0.0414;0.0586;1", "0;0;0;1;1"],
    x: [
      "0;0.0291;0.0705;0.118;0.168;0.2252;0.2679;0.2971;0.6285;0.6577;0.687;0.7295;0.7867;0.8367;0.8843;0.9256;1",
      "233;233;204;187;184;116;130;128;128;126;130;116;184;187;204;233;233",
    ],
    y: [
      "0;0.0291;0.0705;0.118;0.168;0.2252;0.2679;0.2971;0.6285;0.6577;0.687;0.7295;0.7867;0.8367;0.8843;0.9256;1",
      "155;155;126;109;106;39;54;50;50;48;54;39;106;109;126;155;155",
    ],
    width: [
      "0;0.0291;0.0705;0.118;0.168;0.2252;0.2679;0.2971;0.6285;0.6577;0.687;0.7295;0.7867;0.8367;0.8843;0.9256;1",
      "0;0;58;92;98;234;206;210;210;214;206;234;98;92;58;0;0",
    ],
    height: [
      "0;0.0291;0.0705;0.118;0.168;0.2252;0.2679;0.2971;0.6285;0.6577;0.687;0.7295;0.7867;0.8367;0.8843;0.9256;1",
      "0;0;58;92;98;234;206;210;210;214;206;234;98;92;58;0;0",
    ],
    rx: [
      "0;0.0291;0.0705;0.118;0.168;0.2252;0.2679;0.2971;0.6285;0.6577;0.687;0.7295;0.7867;0.8367;0.8843;0.9256;1",
      "0;0;5;7;8;39;32;34;34;35;32;39;8;7;5;0;0",
    ],
  },
  cutout: {
    opacity: ["0;0.0291;0.1426;0.1548;1", "0;0;0;1;1"],
    d: [
      "0;0.0291;0.1266;0.1753;0.2362;0.2971;0.6285;0.687;0.7479;0.7966;1",
      [
        EMPTY_CUTOUT_PATH,
        EMPTY_CUTOUT_PATH,
        EMPTY_CUTOUT_PATH,
        ROUNDED_CUTOUT_PATH,
        ROUNDED_CUTOUT_LARGE_PATH,
        ROUNDED_DIAMOND_PATH,
        ROUNDED_DIAMOND_PATH,
        ROUNDED_CUTOUT_LARGE_PATH,
        ROUNDED_CUTOUT_PATH,
        EMPTY_CUTOUT_PATH,
        EMPTY_CUTOUT_PATH,
      ].join(";"),
    ],
  },
  leftEye: {
    opacity: ["0;0.0291;0.2904;0.3249;0.6285;0.6808;1", "0;0;0;1;1;0;0"],
    rx: ["0;0.0291;0.2904;0.3249;0.6285;0.6808;1", "0;0;0;18.5;18.5;0;0"],
    ry: [
      "0;0.0291;0.2904;0.3249;0.3641;0.392;0.4263;0.4433;0.4713;0.5054;0.6285;0.6808;1",
      "0;0;0;18.5;18.5;2.2;18.5;18.5;2.2;18.5;18.5;0;0",
    ],
  },
  rightEye: {
    opacity: ["0;0.0291;0.2904;0.3249;0.6285;0.6808;1", "0;0;0;1;1;0;0"],
    rx: ["0;0.0291;0.2904;0.3249;0.6285;0.6808;1", "0;0;0;18.5;18.5;0;0"],
    ry: [
      "0;0.0291;0.2904;0.3249;0.3641;0.392;0.4263;0.4433;0.4713;0.5054;0.6285;0.6808;1",
      "0;0;0;18.5;18.5;2.2;18.5;18.5;2.2;18.5;18.5;0;0",
    ],
  },
} satisfies Record<string, Record<string, SvgAnimationTiming>>;

function keySplines(keyTimes: string) {
  return Array.from(
    { length: keyTimes.split(";").length - 1 },
    () => EASE,
  ).join(";");
}

function SvgAnimate({
  attributeName,
  timing,
}: {
  attributeName: string;
  timing: SvgAnimationTiming;
}) {
  const [keyTimes, values] = timing;

  return (
    <animate
      attributeName={attributeName}
      begin="0s"
      calcMode="spline"
      dur={DURATION}
      fill="remove"
      keySplines={keySplines(keyTimes)}
      keyTimes={keyTimes}
      repeatCount={LOOP}
      values={values}
    />
  );
}

function animationsFor(timings: Record<string, SvgAnimationTiming>) {
  return Object.entries(timings).map(([attributeName, timing]) => (
    <SvgAnimate
      key={attributeName}
      attributeName={attributeName}
      timing={timing}
    />
  ));
}

function idPart(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "") || "berd";
}

export interface BerdLoaderProps extends ComponentProps<"svg"> {
  /** When false, renders the settled Berd mark without looping animation. */
  animated?: boolean;
  /**
   * When true, marks the loader as purely decorative:
   * sets `role="none"`, `aria-hidden="true"`, and removes the label.
   */
  decorative?: boolean;
  /** Width and height of the rendered SVG box in CSS pixels. */
  size?: number;
}

function BerdLoader({
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
}: BerdLoaderProps) {
  const maskId = `berd-loader-v9-${idPart(useId())}`;
  const resolvedRole = role ?? (decorative ? "none" : "img");
  const resolvedAriaHidden = ariaHidden ?? (decorative ? true : undefined);
  const resolvedAriaLabel = ariaLabel ?? (decorative ? undefined : "Loading");

  return (
    <svg
      aria-hidden={resolvedAriaHidden}
      aria-label={resolvedAriaLabel}
      className={cn("block shrink-0", className)}
      data-slot="berd-loader"
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
          <path
            d={animated ? EMPTY_CUTOUT_PATH : ROUNDED_DIAMOND_PATH}
            fill="#000"
            opacity={animated ? "0" : "1"}
          >
            {animated ? animationsFor(TIMINGS.cutout) : null}
          </path>
          <ellipse
            cx="166"
            cy="90"
            rx={animated ? "0" : "18.5"}
            ry={animated ? "0" : "18.5"}
            fill="#000"
            opacity={animated ? "0" : "1"}
          >
            {animated ? animationsFor(TIMINGS.leftEye) : null}
          </ellipse>
          <ellipse
            cx="300"
            cy="90"
            rx={animated ? "0" : "18.5"}
            ry={animated ? "0" : "18.5"}
            fill="#000"
            opacity={animated ? "0" : "1"}
          >
            {animated ? animationsFor(TIMINGS.rightEye) : null}
          </ellipse>
        </mask>
      </defs>
      <g mask={`url(#${maskId})`}>
        <rect
          x={animated ? "233" : "128"}
          y={animated ? "155" : "50"}
          width={animated ? "0" : "210"}
          height={animated ? "0" : "210"}
          rx={animated ? "0" : "34"}
        >
          {animated ? animationsFor(TIMINGS.body) : null}
        </rect>
      </g>
    </svg>
  );
}

export { BerdLoader };
