import { useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/shared/lib/cn";
import { usePrefersReducedMotion } from "@/shared/hooks/usePrefersReducedMotion";
import { useSessionActivityStylePreference } from "@/shared/preferences/sessionActivityStylePreference";
import { useWorkingIndicatorAnimationPreference } from "@/shared/preferences/workingIndicatorAnimationPreference";
import { BerdLoaderInline } from "@/shared/ui/berd-loader-inline";
import {
  SessionActivityMotion,
  type SessionActivityState,
  type SessionActivityStyle,
} from "@/shared/ui/session-activity-motion";

/** Branded responding treatment inside the conversation, not compact session status. */
export function ActiveChatBerdIndicator({
  className,
  respectAnimationPreference = false,
  size = 14,
}: {
  className?: string;
  respectAnimationPreference?: boolean;
  size?: number;
}) {
  const shouldReduceMotion = usePrefersReducedMotion();
  const preference = useWorkingIndicatorAnimationPreference();
  return (
    <BerdLoaderInline
      animated={
        !shouldReduceMotion &&
        (!respectAnimationPreference || preference.enabled)
      }
      className={className}
      decorative
      size={size}
    />
  );
}

interface SessionActivityIndicatorProps {
  isRunning?: boolean;
  hasUnread?: boolean;
  variant?: "inline" | "overlay";
  size?: "default" | "sm" | "lg";
  /** Allow a static preview, never override the OS or user animation preference. */
  animated?: boolean;
  /** Preview a specific motion; defaults to the user's Appearance setting. */
  motionStyle?: SessionActivityStyle;
  activeLabel?: string;
  unreadLabel?: string;
  className?: string;
}

/**
 * Keep mounted across state changes: the same four dots (bird, shuffle, or
 * beak motion, per the Appearance setting) gather from their current
 * positions into one unread dot. Idle is hidden and never implies unread/success.
 * Color follows the app's primary token; shape carries meaning without color/motion.
 */
export function SessionActivityIndicator({
  isRunning = false,
  hasUnread = false,
  variant = "inline",
  size = "default",
  animated = true,
  motionStyle,
  activeLabel,
  unreadLabel,
  className,
}: SessionActivityIndicatorProps) {
  const { t } = useTranslation("sidebar");
  const reducedMotion = usePrefersReducedMotion();
  const preference = useWorkingIndicatorAnimationPreference();
  const stylePreference = useSessionActivityStylePreference();
  const style = motionStyle ?? stylePreference.style;
  const motionEnabled = animated && preference.enabled && !reducedMotion;
  const state: SessionActivityState = isRunning
    ? "working"
    : hasUnread
      ? "unread"
      : "idle";
  const svgRef = useRef<SVGSVGElement>(null);
  const modelRef = useRef<SessionActivityMotion | null>(null);
  if (!modelRef.current)
    modelRef.current = new SessionActivityMotion(state, motionEnabled, style);
  const model = modelRef.current;
  const updateRef = useRef<
    ((state: SessionActivityState, animated: boolean) => void) | null
  >(null);
  const restyleRef = useRef<((style: SessionActivityStyle) => void) | null>(
    null,
  );

  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const circles = Array.from(svg.querySelectorAll("circle"));
    let frame = 0;
    let idleFrame = 0;
    let lastTime: number | null = null;
    let visible = typeof IntersectionObserver === "undefined";

    function paint() {
      model.pose.forEach((dot, index) => {
        circles[index].setAttribute("cx", String(10 + dot.x));
        circles[index].setAttribute("cy", String(10 + dot.y));
        circles[index].setAttribute("r", String(dot.radius));
      });
    }
    function tick(now: number) {
      frame = 0;
      if (!visible || document.hidden) return;
      model.step(lastTime === null ? 0 : Math.min(50, now - lastTime));
      lastTime = now;
      paint();
      if (model.moving) frame = requestAnimationFrame(tick);
    }
    function resume() {
      cancelAnimationFrame(frame);
      frame = 0;
      lastTime = null;
      if (visible && !document.hidden && model.moving)
        frame = requestAnimationFrame(tick);
    }
    updateRef.current = (nextState, nextAnimated) => {
      cancelAnimationFrame(idleFrame);
      idleFrame = 0;
      const apply = () => {
        idleFrame = 0;
        model.setState(nextState, nextAnimated);
        paint();
        resume();
      };
      // The wrapper hides idle immediately. Keep the last pose for one frame
      // in case stopped/unread arrive separately; never synthesize unread.
      if (nextState === "idle" && nextAnimated && model.moving) {
        cancelAnimationFrame(frame);
        frame = 0;
        idleFrame = requestAnimationFrame(apply);
      } else apply();
    };
    restyleRef.current = (nextStyle) => {
      model.setStyle(nextStyle);
      paint();
      resume();
    };
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(([entry]) => {
            visible = entry.isIntersecting;
            resume();
          });
    observer?.observe(svg);
    document.addEventListener("visibilitychange", resume);
    paint();
    resume();
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(idleFrame);
      observer?.disconnect();
      document.removeEventListener("visibilitychange", resume);
      updateRef.current = null;
      restyleRef.current = null;
    };
  }, [model]);

  useLayoutEffect(() => {
    updateRef.current?.(state, motionEnabled);
  }, [state, motionEnabled]);

  useLayoutEffect(() => {
    restyleRef.current?.(style);
  }, [style]);

  const label =
    state === "working"
      ? (activeLabel ?? t("status.chatActive"))
      : state === "unread"
        ? (unreadLabel ?? t("status.unreadMessages"))
        : undefined;
  return (
    <span
      role="status"
      aria-label={label}
      aria-hidden={state === "idle" ? true : undefined}
      data-slot="session-activity-indicator"
      data-state={state}
      data-animated={motionEnabled}
      data-motion-style={style}
      className={cn(
        "pointer-events-none inline-flex shrink-0 items-center justify-center text-primary",
        variant === "overlay" && "absolute -right-2 -top-2",
        className,
      )}
      style={{ display: state === "idle" ? "none" : undefined }}
    >
      <svg
        ref={svgRef}
        aria-hidden="true"
        viewBox="0 0 20 20"
        fill="currentColor"
        className={cn(
          "text-primary",
          size === "sm" ? "size-4" : size === "lg" ? "size-10" : "size-5",
        )}
      >
        {model.pose.map((dot, index) => (
          <circle key={index} cx={10 + dot.x} cy={10 + dot.y} r={dot.radius} />
        ))}
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}
