import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createVirtualLayoutStabilityAttributes,
  type VirtualLayoutStabilityAttributes,
} from "./transcriptLayoutPending";

const DEFAULT_LAYOUT_PENDING_ANIMATION_MS = 220;

export function useVirtualLayoutPendingForChange(
  changeKey: unknown,
  durationMs: number = DEFAULT_LAYOUT_PENDING_ANIMATION_MS,
): boolean {
  const hasMountedRef = useRef(false);
  const lastChangeKeyRef = useRef(changeKey);
  const [isPending, setIsPending] = useState(false);

  useEffect(() => {
    lastChangeKeyRef.current = changeKey;

    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }

    setIsPending(true);
    const timeout = setTimeout(() => {
      setIsPending(false);
    }, durationMs);

    return () => {
      clearTimeout(timeout);
    };
  }, [changeKey, durationMs]);

  return isPending;
}

export interface VirtualStreamdownLayoutPendingInput {
  contentKey: unknown;
  isAnimating?: boolean;
  mode?: "static" | "streaming";
  onAnimationStart?: () => void;
  onAnimationEnd?: () => void;
}

export interface VirtualStreamdownLayoutPendingAdapter {
  isPending: boolean;
  layoutPendingAttributes: VirtualLayoutStabilityAttributes;
  onAnimationStart: () => void;
  onAnimationEnd: () => void;
}

export function useVirtualLayoutPendingForStreamdown({
  contentKey,
  isAnimating = false,
  mode = "streaming",
  onAnimationStart,
  onAnimationEnd,
}: VirtualStreamdownLayoutPendingInput): VirtualStreamdownLayoutPendingAdapter {
  const isContentChangePending = useVirtualLayoutPendingForChange(contentKey);
  const [isAnimationPending, setIsAnimationPending] = useState(
    () => mode !== "static" && isAnimating,
  );

  useEffect(() => {
    if (mode === "static") {
      setIsAnimationPending(false);
      return;
    }

    if (isAnimating) {
      setIsAnimationPending(true);
    }
  }, [isAnimating, mode]);

  const handleAnimationStart = useCallback(() => {
    if (mode !== "static") {
      setIsAnimationPending(true);
    }
    onAnimationStart?.();
  }, [mode, onAnimationStart]);

  const handleAnimationEnd = useCallback(() => {
    setIsAnimationPending(false);
    onAnimationEnd?.();
  }, [onAnimationEnd]);

  const isPending =
    mode !== "static" &&
    (isAnimating || isAnimationPending || isContentChangePending);
  const layoutPendingAttributes = useMemo(
    () =>
      createVirtualLayoutStabilityAttributes({
        isPending,
        reason: "streamdown-async",
      }),
    [isPending],
  );

  return useMemo(
    () => ({
      isPending,
      layoutPendingAttributes,
      onAnimationEnd: handleAnimationEnd,
      onAnimationStart: handleAnimationStart,
    }),
    [
      handleAnimationEnd,
      handleAnimationStart,
      isPending,
      layoutPendingAttributes,
    ],
  );
}
