import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
  targetRef: RefObject<HTMLDivElement | null>;
  bindTargetEvents?: boolean;
  onDropFiles: (files: File[]) => void;
  onDropPaths: (paths: string[]) => void;
}

const NATIVE_DROP_EXPECTED_MS = 1000;
const NATIVE_DROP_HANDLED_SUPPRESSION_MS = 500;
const INTERNAL_APP_DRAG_DATA_TYPE = "application/x-goose-internal-drag";

function isInternalAppDrag(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.types).includes(INTERNAL_APP_DRAG_DATA_TYPE);
}

function isInternalAppDragActive() {
  return (
    typeof document !== "undefined" &&
    document.documentElement.dataset.gooseInternalDrag != null
  );
}

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
  targetRef,
  bindTargetEvents = false,
  onDropFiles,
  onDropPaths,
}: UseAttachmentDropTargetOptions) {
  const [isAttachmentDragOver, setIsAttachmentDragOverState] = useState(false);
  const isAttachmentDragOverRef = useRef(false);
  const disabledRef = useRef(disabled);
  const onDropFilesRef = useRef(onDropFiles);
  const onDropPathsRef = useRef(onDropPaths);
  const targetRefRef = useRef(targetRef);
  const dragDepthRef = useRef(0);
  const tauriDropHandledAtRef = useRef(0);
  const nativeDropExpectedUntilRef = useRef(0);
  const nativeDragActiveTimeoutRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  useLayoutEffect(() => {
    disabledRef.current = disabled;
    onDropFilesRef.current = onDropFiles;
    onDropPathsRef.current = onDropPaths;
    targetRefRef.current = targetRef;
  }, [disabled, onDropFiles, onDropPaths, targetRef]);

  const setIsAttachmentDragOver = useCallback((isDragOver: boolean) => {
    isAttachmentDragOverRef.current = isDragOver;
    setIsAttachmentDragOverState(isDragOver);
  }, []);

  const clearNativeDragWatchdog = useCallback(() => {
    if (nativeDragActiveTimeoutRef.current != null) {
      clearTimeout(nativeDragActiveTimeoutRef.current);
      nativeDragActiveTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!disabled) return;
    clearNativeDragWatchdog();
    dragDepthRef.current = 0;
    nativeDropExpectedUntilRef.current = 0;
    setIsAttachmentDragOver(false);
  }, [clearNativeDragWatchdog, disabled, setIsAttachmentDragOver]);

  // Safety-net: force-reset the overlay when the drag operation ends without a
  // proper target drop/leave cycle. This covers OS-level drag cancellation
  // (Escape in Finder, window losing focus mid-drag, etc.) and drops that land
  // elsewhere in the app after first entering the attachment target.
  useEffect(() => {
    const resetDragState = () => {
      if (dragDepthRef.current > 0 || isAttachmentDragOverRef.current) {
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

    // A document-level drop means the drag operation finished, even if it did
    // not finish on the attachment target itself.
    const handleDocumentDrop = (event: DragEvent) => {
      const target = targetRefRef.current.current;
      const eventTarget = event.target;
      if (
        target &&
        eventTarget instanceof Node &&
        target.contains(eventTarget)
      ) {
        return;
      }
      resetDragState();
    };

    window.addEventListener("dragend", handleDragEnd);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("blur", handleWindowBlur);
    document.addEventListener("drop", handleDocumentDrop);
    return () => {
      window.removeEventListener("dragend", handleDragEnd);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("blur", handleWindowBlur);
      document.removeEventListener("drop", handleDocumentDrop);
    };
  }, [clearNativeDragWatchdog, setIsAttachmentDragOver]);

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
      if (isInternalAppDrag(dataTransfer) || isInternalAppDragActive()) {
        event.preventDefault();
        dragDepthRef.current = 0;
        setIsAttachmentDragOver(false);
        return;
      }
      const draggedFiles = hasDraggedFiles(dataTransfer);
      if (disabled || !draggedFiles) {
        return;
      }

      event.preventDefault();
      dragDepthRef.current += 1;
      setIsAttachmentDragOver(true);
    },
    [disabled, setIsAttachmentDragOver],
  );

  const handleDragOver = useCallback(
    (event: AttachmentDragEvent) => {
      const dataTransfer = event.dataTransfer;
      if (!dataTransfer) return;
      if (isInternalAppDrag(dataTransfer) || isInternalAppDragActive()) {
        event.preventDefault();
        dragDepthRef.current = 0;
        setIsAttachmentDragOver(false);
        return;
      }
      const draggedFiles = hasDraggedFiles(dataTransfer);
      if (disabled || !draggedFiles) {
        return;
      }

      event.preventDefault();
      dataTransfer.dropEffect = "copy";
      setIsAttachmentDragOver(true);
    },
    [disabled, setIsAttachmentDragOver],
  );

  const handleDragLeave = useCallback(
    (event: AttachmentDragEvent) => {
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
    },
    [setIsAttachmentDragOver],
  );

  const handleDrop = useCallback(
    (event: AttachmentDragEvent) => {
      const dataTransfer = event.dataTransfer;
      if (!dataTransfer) return;
      if (isInternalAppDrag(dataTransfer) || isInternalAppDragActive()) {
        event.preventDefault();
        dragDepthRef.current = 0;
        setIsAttachmentDragOver(false);
        return;
      }
      const draggedFiles = hasDraggedFiles(dataTransfer);
      if (disabled || !draggedFiles) {
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
        onDropFilesRef.current(files);
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

      onDropFilesRef.current(files);
    },
    [disabled, setIsAttachmentDragOver],
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
      .then(({ getCurrentWebview }) => {
        if (disposed) {
          return undefined;
        }
        return getCurrentWebview().onDragDropEvent(({ payload }) => {
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

          if (isInternalAppDragActive()) {
            clearNativeDragWatchdog();
            dragDepthRef.current = 0;
            nativeDropExpectedUntilRef.current = 0;
            setIsAttachmentDragOver(false);
            return;
          }

          const hitTest = getTargetHitTest(
            targetRefRef.current.current,
            payload.position,
          );

          if (payload.type === "drop") {
            clearNativeDragWatchdog();
            dragDepthRef.current = 0;
            setIsAttachmentDragOver(false);
            const nativeDropWasExpected =
              nativeDropExpectedUntilRef.current > Date.now();
            nativeDropExpectedUntilRef.current = 0;
            if (
              (!hitTest.inside && !nativeDropWasExpected) ||
              disabledRef.current ||
              payload.paths.length === 0
            ) {
              return;
            }
            tauriDropHandledAtRef.current = Date.now();
            onDropPathsRef.current(payload.paths);
            return;
          }

          // `over` event — reset the watchdog so it doesn't fire while the
          // user is still actively dragging.
          resetWatchdog();

          const nativeDropIsOverTarget = hitTest.inside && !disabledRef.current;
          if (nativeDropIsOverTarget) {
            nativeDropExpectedUntilRef.current =
              Date.now() + NATIVE_DROP_EXPECTED_MS;
          } else {
            nativeDropExpectedUntilRef.current = 0;
          }
          setIsAttachmentDragOver(nativeDropIsOverTarget);
        });
      })
      .then((fn) => {
        if (!fn) {
          return;
        }
        if (disposed) {
          fn();
          return;
        }
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
  }, [clearNativeDragWatchdog, setIsAttachmentDragOver]);

  return {
    isAttachmentDragOver,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  };
}
