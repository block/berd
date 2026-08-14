import type { ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/shared/lib/cn";

const REFRACTION_LOBES = [
  {
    x: -18,
    y: -10,
    rotate: -12,
    scaleX: 1.15,
    scaleY: 0.72,
    color: "rgba(100, 220, 255, 0.52)",
  },
  {
    x: 20,
    y: 4,
    rotate: 24,
    scaleX: 0.82,
    scaleY: 1.08,
    color: "rgba(239, 112, 255, 0.4)",
  },
  {
    x: -2,
    y: 18,
    rotate: 8,
    scaleX: 1.02,
    scaleY: 0.76,
    color: "rgba(255, 218, 92, 0.34)",
  },
] as const;

interface AgentCardRevealProps {
  children: ReactNode;
  identity: string;
  className?: string;
}

/** Shared entrance and refraction treatment for generated and imported cards. */
export function AgentCardReveal({
  children,
  identity,
  className,
}: AgentCardRevealProps) {
  const shouldReduceMotion = useReducedMotion();

  return (
    <div
      data-agent-card-reveal="true"
      className={cn(
        "relative isolate w-full max-w-[min(22rem,calc((100dvh-18rem)*0.6667))] overflow-visible p-6 [transform-style:preserve-3d]",
        className,
      )}
    >
      {!shouldReduceMotion ? (
        <div
          key={`refraction:${identity}`}
          aria-hidden="true"
          data-agent-card-refraction="true"
          className="pointer-events-none absolute inset-0 z-0"
        >
          {REFRACTION_LOBES.map((lobe) => (
            <motion.div
              key={`${lobe.x}:${lobe.y}`}
              initial={{
                opacity: 0,
                x: lobe.x * 0.3,
                y: lobe.y * 0.3,
                scaleX: lobe.scaleX * 0.78,
                scaleY: lobe.scaleY * 0.78,
                rotate: lobe.rotate - 5,
              }}
              animate={{
                opacity: [0, 0.76, 0.46, 0],
                x: [lobe.x * 0.3, lobe.x],
                y: [lobe.y * 0.3, lobe.y],
                scaleX: [lobe.scaleX * 0.78, lobe.scaleX],
                scaleY: [lobe.scaleY * 0.78, lobe.scaleY],
                rotate: [lobe.rotate - 5, lobe.rotate + 4],
              }}
              transition={{
                default: { duration: 1.4, ease: [0.65, 0, 0.35, 1] },
                opacity: {
                  duration: 1.4,
                  times: [0, 0.16, 0.48, 1],
                  ease: [0.45, 0, 0.55, 1],
                },
              }}
              className="absolute top-1/2 left-1/2 size-[170%] -translate-x-1/2 -translate-y-1/2 rounded-[44%] blur-xl"
              style={{
                background: `radial-gradient(ellipse, ${lobe.color} 0%, ${lobe.color} 24%, transparent 72%)`,
                boxShadow: `0 0 150px 85px ${lobe.color}`,
              }}
            />
          ))}
        </div>
      ) : null}
      <motion.div
        data-agent-card-reveal-content="true"
        key={identity}
        initial={
          shouldReduceMotion ? false : { opacity: 0, rotateY: -92, scale: 0.92 }
        }
        animate={{ opacity: 1, rotateY: 0, scale: 1 }}
        transition={{
          duration: shouldReduceMotion ? 0 : 0.45,
          ease: [0.22, 1, 0.36, 1],
        }}
        className="relative z-10 mx-auto w-full max-w-[19rem] [transform-style:preserve-3d]"
      >
        {children}
      </motion.div>
    </div>
  );
}
