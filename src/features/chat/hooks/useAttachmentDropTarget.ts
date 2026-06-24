import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type RefObject,
} from "react";

type AttachmentDragEvent =
  | ReactDragEvent<HTMLDivElement>
  | globalThis.DragEvent;

interface UseAttachmentDropTargetOptions {
  disabled: boolean;
  isStreaming: boolean;
  targetRef: RefObject<HTMLDivElement | null>;
  bindTargetEvents?: boolean;
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
  bindTargetEvents = false,
  onDropFiles,
  onDropPaths,
}: UseAttachmentDropTargetOptions) {
  const [isAttachmentDragOver, setIsAttachmentDragOver] = useState(false);
  const dragDepthRef = useRef(0);
  const tauriDropHandledAtRef = useRef(0);
  const nativeDropExpectedUntilRef = useRef(0);
  const nativeDragActiveTimeoutRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  const clearNativeDragWatchdog = useCallback(() => {
    if (nativeDragActiveTimeoutRef.current != null) {
      clearTimeout(nativeDragActiveTimeoutRef.current);
      nativeDragActiveTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!disabled && !isStreaming) return;
    clearNativeDragWatchdog();
    dragDepthRef.current = 0;
    nativeDropExpectedUntilRef.current = 0;
    setIsAttachmentDragOver(false);
  }, [clearNativeDragWatchdog, disabled, isStreaming]);

  // Safety-net: force-reset the overlay when the drag operation ends without a
  // proper drop/leave cycle. This covers OS-level drag cancellation (Escape in
  // Finder, window losing focus mid-drag, etc.) that can leave the overlay
  // stuck because neither `dragleave` nor the Tauri `leave` event fires.
  useEffect(() => {
    const resetDragState = () => {
      if (dragDepthRef.current > 0 || isAttachmentDragOver) {
        clearNativeDragWatchdog();
        dragDepthRef.current = 0;
        nativeDropExpectedUntilRef.current = 0;
        setIsAttachmentDragOver(false);
      }
    };

    // `dragend` fires on the drag source when the operation finishes (drop or
    // cancel). In Tauri the source is outside the webview so this mainly helps
    // with intra-webview drags, but it's a cheap safety net.
    const handleDragEnd = () => resetDragState();

    // Escape key should always dismiss the overlay, even if the underlying
    // drag events are lost.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        resetDragState();
      }
    };

    // Window blur means the user switched away mid-drag — the drag is
    // effectively cancelled from our perspective.
    const handleWindowBlur = () => resetDragState();

    window.addEventListener("dragend", handleDragEnd);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("dragend", handleDragEnd);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [clearNativeDragWatchdog, isAttachmentDragOver]);

  const handleDragEnter = useCallback(
    (event: AttachmentDragEvent) => {
      const currentTarget = event.currentTarget;
      const relatedTarget = event.relatedTarget;
      if (
        currentTarget instanceof Node &&
        relatedTarget instanceof Node &&
        currentTarget.contains(relatedTarget)
      ) {
        return;
      }

      const dataTransfer = event.dataTransfer;
      if (!dataTransfer) return;
      const draggedFiles = hasDraggedFiles(dataTransfer);
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
    (event: AttachmentDragEvent) => {
      const dataTransfer = event.dataTransfer;
      if (!dataTransfer) return;
      const draggedFiles = hasDraggedFiles(dataTransfer);
      if (disabled || isStreaming || !draggedFiles) {
        return;
      }

      event.preventDefault();
      dataTransfer.dropEffect = "copy";
      setIsAttachmentDragOver(true);
    },
    [disabled, isStreaming],
  );

  const handleDragLeave = useCallback((event: AttachmentDragEvent) => {
    event.preventDefault();
    const currentTarget = event.currentTarget;
    const relatedTarget = event.relatedTarget;
    if (
      currentTarget instanceof Node &&
      relatedTarget instanceof Node &&
      currentTarget.contains(relatedTarget)
    ) {
      return;
    }

    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsAttachmentDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    (event: AttachmentDragEvent) => {
      const dataTransfer = event.dataTransfer;
      if (!dataTransfer) return;
      const draggedFiles = hasDraggedFiles(dataTransfer);
      if (disabled || isStreaming || !draggedFiles) {
        return;
      }

      event.preventDefault();
      dragDepthRef.current = 0;
      setIsAttachmentDragOver(false);

      const files = Array.from(dataTransfer.files);
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
      // drag event over the active attachment target, let the native path drop
      // win. Otherwise keep the browser fallback immediate so ordinary DOM drops
      // still work.
      if (nativeDropExpectedUntilRef.current > Date.now()) {
        return;
      }

      onDropFiles(files);
    },
    [disabled, isStreaming, onDropFiles],
  );

  useEffect(() => {
    if (!bindTargetEvents) {
      return;
    }

    const target = targetRef.current;
    if (!target) {
      return;
    }

    target.addEventListener("dragenter", handleDragEnter);
    target.addEventListener("dragover", handleDragOver);
    target.addEventListener("dragleave", handleDragLeave);
    target.addEventListener("drop", handleDrop);
    return () => {
      target.removeEventListener("dragenter", handleDragEnter);
      target.removeEventListener("dragover", handleDragOver);
      target.removeEventListener("dragleave", handleDragLeave);
      target.removeEventListener("drop", handleDrop);
    };
  }, [
    bindTargetEvents,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    targetRef,
  ]);

  useEffect(() => {
    if (!isInTauriEnvironment()) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;

    // Tauri's native drag events don't always fire a `leave` when the drag is
    // cancelled (e.g., Escape pressed in Finder). Use a watchdog timer: if we
    // see an `over` event but no `leave`/`drop` within a generous window, reset.
    const NATIVE_DRAG_WATCHDOG_MS = 3000;

    const resetWatchdog = () => {
      clearNativeDragWatchdog();
      nativeDragActiveTimeoutRef.current = setTimeout(() => {
        if (!disposed) {
          dragDepthRef.current = 0;
          nativeDropExpectedUntilRef.current = 0;
          setIsAttachmentDragOver(false);
        }
      }, NATIVE_DRAG_WATCHDOG_MS);
    };

    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent(({ payload }) => {
          if (disposed) {
            return;
          }

          if (payload.type === "leave") {
            clearNativeDragWatchdog();
            dragDepthRef.current = 0;
            setIsAttachmentDragOver(false);
            nativeDropExpectedUntilRef.current = 0;
            return;
          }

          const hitTest = getTargetHitTest(targetRef.current, payload.position);

          if (payload.type === "drop") {
            clearNativeDragWatchdog();
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

          // `over` event — reset the watchdog so it doesn't fire while the
          // user is still actively dragging.
          resetWatchdog();

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
      clearNativeDragWatchdog();
      unlisten?.();
    };
  }, [clearNativeDragWatchdog, disabled, isStreaming, onDropPaths, targetRef]);

  return {
    isAttachmentDragOver,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  };
}
