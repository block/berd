import { useLayoutEffect, useRef, useState } from "react";

const GESTURE_END_HOLD_MS = 480;

/**
 * Captures a static image when a home-canvas drag/resize starts so heavy widget
 * content (WebGL, large avatars) does not flash blank while the container moves.
 */
export function useWidgetGestureFreeze(
  gestureActive: boolean,
  captureSnapshot: () => string | null | undefined,
) {
  const captureRef = useRef(captureSnapshot);
  captureRef.current = captureSnapshot;
  const lastGoodSnapshotRef = useRef<string | null>(null);
  const wasActiveRef = useRef(false);
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (gestureActive) {
      wasActiveRef.current = true;

      if (lastGoodSnapshotRef.current) {
        setSnapshotUrl(lastGoodSnapshotRef.current);
      }

      let frameId = 0;
      const capture = () => {
        const url = captureRef.current();
        if (url && url !== "data:,") {
          lastGoodSnapshotRef.current = url;
          setSnapshotUrl(url);
        }
      };

      frameId = requestAnimationFrame(() => {
        frameId = requestAnimationFrame(capture);
      });

      return () => {
        cancelAnimationFrame(frameId);
      };
    }

    if (!wasActiveRef.current) {
      return;
    }
    wasActiveRef.current = false;

    const latest = captureRef.current();
    if (latest && latest !== "data:,") {
      lastGoodSnapshotRef.current = latest;
      setSnapshotUrl(latest);
    }

    const timeout = window.setTimeout(() => {
      setSnapshotUrl(null);
    }, GESTURE_END_HOLD_MS);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [gestureActive]);

  return snapshotUrl;
}
