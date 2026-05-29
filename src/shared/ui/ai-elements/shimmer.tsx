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
  tone?: "default" | "soft" | "strong";
}

const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
  delay = 0,
  tone = "default",
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
      tone === "strong"
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
        className,
      )}
      style={
        {
          "--spread": `${dynamicSpread}px`,
          "--bg":
            "linear-gradient(90deg, #0000 calc(50% - var(--spread)), var(--shimmer-highlight), #0000 calc(50% + var(--spread)))",
          "--shimmer-delay": `${delay}s`,
          "--shimmer-duration": `${duration}s`,
          "--shimmer-base": shimmerColors.base,
          "--shimmer-highlight": shimmerColors.highlight,
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
