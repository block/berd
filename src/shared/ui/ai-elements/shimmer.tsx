import { cn } from "@/shared/lib/cn";
import type { MotionProps } from "motion/react";
import { motion } from "motion/react";
import type { CSSProperties, ElementType, JSX } from "react";
import { memo, useMemo } from "react";

type MotionHTMLProps = MotionProps & Record<string, unknown>;

// Cache motion components at module level to avoid creating during render
const motionComponentCache = new Map<
  keyof JSX.IntrinsicElements,
  React.ComponentType<MotionHTMLProps>
>();

const getMotionComponent = (element: keyof JSX.IntrinsicElements) => {
  let component = motionComponentCache.get(element);
  if (!component) {
    component = motion.create(element);
    motionComponentCache.set(element, component);
  }
  return component;
};

export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
  delay?: number;
  angle?: number;
  continuous?: boolean;
  tone?: "default" | "soft" | "strong" | "current";
  baseColor?: string;
  highlightColor?: string;
}

/** Shared motion recipe used by Responding… and running sidebar chats. */
export const RESPONDING_SHIMMER_PROPS = {
  angle: 100,
  continuous: true,
  delay: 0.35,
  duration: 2.2,
  spread: 2.5,
  tone: "current",
} as const satisfies Pick<
  TextShimmerProps,
  "angle" | "continuous" | "delay" | "duration" | "spread" | "tone"
>;

const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
  delay = 0,
  angle = 90,
  continuous = false,
  tone = "default",
  baseColor,
  highlightColor,
}: TextShimmerProps) => {
  const MotionComponent = getMotionComponent(
    Component as keyof JSX.IntrinsicElements,
  );

  const dynamicSpread = useMemo(
    () => (children?.length ?? 0) * spread,
    [children, spread],
  );
  const shimmerColors = useMemo(
    () =>
      tone === "current"
        ? {
            // Derive from an inheritable ink variable so the shimmer stays
            // legible on surfaces whose foreground is fixed across themes (e.g.
            // the always-dark responding pill). We can't use `currentColor`
            // here because bg-clip-text sets this element's color to
            // transparent. Surfaces set `--shimmer-ink` to their text token;
            // otherwise it falls back to the normal foreground.
            base: "color-mix(in srgb, var(--shimmer-ink, var(--color-foreground)) 55%, transparent)",
            highlight: "var(--shimmer-ink, var(--color-foreground))",
          }
        : tone === "strong"
          ? {
              base: "var(--color-muted-foreground)",
              highlight: "var(--color-foreground)",
            }
          : tone === "soft"
            ? {
                base: "var(--color-muted-foreground)",
                highlight:
                  "color-mix(in srgb, var(--color-foreground) 72%, var(--color-muted-foreground) 28%)",
              }
            : {
                base: "var(--color-muted-foreground)",
                highlight: "var(--color-background)",
              },
    [tone],
  );

  return (
    <MotionComponent
      className={cn(
        "shimmer-text",
        "relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent",
        "[background-repeat:no-repeat,padding-box]",
        continuous && "shimmer-text-continuous",
        className,
      )}
      style={
        {
          "--spread": `${dynamicSpread}px`,
          "--bg": `linear-gradient(${angle}deg, #0000 calc(50% - var(--spread)), var(--shimmer-highlight), #0000 calc(50% + var(--spread)))`,
          "--shimmer-delay": `${delay}s`,
          "--shimmer-duration": `${duration}s`,
          "--shimmer-base": baseColor ?? shimmerColors.base,
          "--shimmer-highlight": highlightColor ?? shimmerColors.highlight,
          backgroundImage:
            "var(--bg), linear-gradient(var(--shimmer-base), var(--shimmer-base))",
          backgroundPosition: "130% center, 0 0",
        } as CSSProperties
      }
    >
      {children}
    </MotionComponent>
  );
};

export const Shimmer = memo(ShimmerComponent);
