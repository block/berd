import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type RefObject,
} from "react";

interface UseAttachmentDropTargetOptions {
  disabled: boolean;
  isStreaming: boolean;
  targetRef: RefObject<HTMLDivElement | null>;
  onDropFiles: (files: File[]) => void;
  onDropPaths: (paths: string[]) => void;
}

const NATIVE_DROP_EXPECTED_MS = 1000;
const NATIVE_DROP_HANDLED_SUPPRESSION_MS = 500;

function hasDraggedFiles(dataTransfer: DataTransfer) {
  return (
    Array.from(dataTransfer.items).some((item) => item.kind === "file") ||
    Array.from(dataTransfer.types).includes("Files")
  );
}

function isInTauriEnvironment() {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

function isPointInsideRect(point: { x: number; y: number }, rect: DOMRect) {
  return (
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  );
}

function getTargetHitTest(
  target: HTMLDivElement | null,
  position: { x: number; y: number },
) {
  if (!target) {
    return {
      inside: false,
      rawInside: false,
      scaledInside: false,
      rawElementInside: false,
      scaledElementInside: false,
      rawPosition: position,
      scaledPosition: position,
      rect: null,
      scale: 1,
    };
  }

  const rect = target.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const rawPosition = { x: position.x, y: position.y };
  const scaledPosition = {
    x: position.x / scale,
    y: position.y / scale,
  };
  const rawInside = isPointInsideRect(rawPosition, rect);
  const scaledInside = isPointInsideRect(scaledPosition, rect);
  const rawElement = document.elementFromPoint(rawPosition.x, rawPosition.y);
  const scaledElement = document.elementFromPoint(
    scaledPosition.x,
    scaledPosition.y,
  );
  const rawElementInside = Boolean(rawElement && target.contains(rawElement));
  const scaledElementInside = Boolean(
    scaledElement && target.contains(scaledElement),
  );

  return {
    inside:
      rawInside || scaledInside || rawElementInside || scaledElementInside,
    rawInside,
    scaledInside,
    rawElementInside,
    scaledElementInside,
    rawPosition,
    scaledPosition,
    rect: {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    },
    scale,
  };
}

export function useAttachmentDropTarget({
  disabled,
  isStreaming,
  targetRef,
  onDropFiles,
  onDropPaths,
}: UseAttachmentDropTargetOptions) {
  const [isAttachmentDragOver, setIsAttachmentDragOver] = useState(false);
  const dragDepthRef = useRef(0);
  const tauriDropHandledAtRef = useRef(0);
  const nativeDropExpectedUntilRef = useRef(0);
  const handleDragEnter = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const draggedFiles = hasDraggedFiles(event.dataTransfer);
      if (disabled || isStreaming || !draggedFiles) {
        return;
      }

      event.preventDefault();
      dragDepthRef.current += 1;
      setIsAttachmentDragOver(true);
    },
    [disabled, isStreaming],
  );

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const draggedFiles = hasDraggedFiles(event.dataTransfer);
      if (disabled || isStreaming || !draggedFiles) {
        return;
      }

      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setIsAttachmentDragOver(true);
    },
    [disabled, isStreaming],
  );

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsAttachmentDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const draggedFiles = hasDraggedFiles(event.dataTransfer);
      if (disabled || isStreaming || !draggedFiles) {
        return;
      }

      event.preventDefault();
      dragDepthRef.current = 0;
      setIsAttachmentDragOver(false);

      const files = Array.from(event.dataTransfer.files);
      if (files.length === 0) {
        return;
      }

      if (
        Date.now() - tauriDropHandledAtRef.current <
        NATIVE_DROP_HANDLED_SUPPRESSION_MS
      ) {
        return;
      }

      if (!isInTauriEnvironment()) {
        onDropFiles(files);
        return;
      }

      // In Tauri, local file drops can arrive through both DOM File objects
      // and native webview drag/drop events. If we have already seen a native
      // drag event over the composer, let the native path drop win. Otherwise
      // keep the browser fallback immediate so ordinary DOM drops still work.
      if (nativeDropExpectedUntilRef.current > Date.now()) {
        return;
      }

      onDropFiles(files);
    },
    [disabled, isStreaming, onDropFiles],
  );

  useEffect(() => {
    if (!isInTauriEnvironment()) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent(({ payload }) => {
          if (disposed) {
            return;
          }

          if (payload.type === "leave") {
            setIsAttachmentDragOver(false);
            nativeDropExpectedUntilRef.current = 0;
            return;
          }

          const hitTest = getTargetHitTest(targetRef.current, payload.position);

          if (payload.type === "drop") {
            setIsAttachmentDragOver(false);
            const nativeDropWasExpected =
              nativeDropExpectedUntilRef.current > Date.now();
            if (
              (!hitTest.inside && !nativeDropWasExpected) ||
              disabled ||
              isStreaming ||
              payload.paths.length === 0
            ) {
              return;
            }
            nativeDropExpectedUntilRef.current = 0;
            tauriDropHandledAtRef.current = Date.now();
            onDropPaths(payload.paths);
            return;
          }

          const nativeDropIsOverTarget =
            hitTest.inside && !disabled && !isStreaming;
          if (nativeDropIsOverTarget) {
            nativeDropExpectedUntilRef.current =
              Date.now() + NATIVE_DROP_EXPECTED_MS;
          } else {
            nativeDropExpectedUntilRef.current = 0;
          }
          setIsAttachmentDragOver(nativeDropIsOverTarget);
        }),
      )
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        setIsAttachmentDragOver(false);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [disabled, isStreaming, onDropPaths, targetRef]);

  return {
    isAttachmentDragOver,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  };
}
