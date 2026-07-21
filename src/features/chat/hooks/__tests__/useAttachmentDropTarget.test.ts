import { createElement, Suspense, type PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAttachmentDropTarget } from "../useAttachmentDropTarget";

type NativeDragDropEvent = {
  payload:
    | { type: "leave"; position: { x: number; y: number } }
    | { type: "drop"; position: { x: number; y: number }; paths: string[] }
    | { type: "over"; position: { x: number; y: number }; paths: string[] };
};

type NativeDragDropListener = (event: NativeDragDropEvent) => void;

let dragDropListener: NativeDragDropListener | null = null;
const mockUnlisten = vi.fn();
const mockOnDragDropEvent = vi.fn(
  (listener: NativeDragDropListener): Promise<() => void> => {
    dragDropListener = listener;
    return Promise.resolve(mockUnlisten);
  },
);

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: mockOnDragDropEvent,
  }),
}));

function createDropTarget({
  left = 0,
  top = 0,
  right = 100,
  bottom = 100,
}: {
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
} = {}) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect);
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn((x: number, y: number) =>
      x >= left && x <= right && y >= top && y <= bottom ? target : null,
    ),
  });

  return {
    target,
    targetRef: { current: target },
    cleanup: () => target.remove(),
  };
}

function createDomDropEvent(file: File) {
  return {
    preventDefault: vi.fn(),
    dataTransfer: {
      files: [file],
      items: [{ kind: "file" }],
      types: ["Files"],
      dropEffect: "copy",
    },
  } as unknown as React.DragEvent<HTMLDivElement>;
}

function createInternalDragEvent() {
  return {
    preventDefault: vi.fn(),
    dataTransfer: {
      files: [],
      items: [],
      types: ["application/x-goose-internal-drag"],
      dropEffect: "none",
    },
  } as unknown as React.DragEvent<HTMLDivElement>;
}

describe("useAttachmentDropTarget", () => {
  beforeEach(() => {
    dragDropListener = null;
    mockUnlisten.mockClear();
    mockOnDragDropEvent.mockClear();
    mockOnDragDropEvent.mockImplementation(
      (listener: NativeDragDropListener): Promise<() => void> => {
        dragDropListener = listener;
        return Promise.resolve(mockUnlisten);
      },
    );
    window.__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    delete document.documentElement.dataset.gooseInternalDrag;
    vi.restoreAllMocks();
  });

  it("uses native Tauri paths instead of a pathless DOM file when native drag is active", async () => {
    const { targetRef, cleanup } = createDropTarget();
    const onDropFiles = vi.fn();
    const onDropPaths = vi.fn();

    const { result, unmount } = renderHook(() =>
      useAttachmentDropTarget({
        disabled: false,
        targetRef,
        onDropFiles,
        onDropPaths,
      }),
    );

    await waitFor(() => expect(dragDropListener).not.toBeNull());

    act(() => {
      dragDropListener?.({
        payload: {
          type: "over",
          position: { x: 10, y: 10 },
          paths: ["/Users/test/report.pdf"],
        },
      });
    });

    const domDrop = createDomDropEvent(
      new File(["pdf"], "report.pdf", { type: "application/pdf" }),
    );
    act(() => {
      result.current.handleDrop(domDrop);
    });

    expect(domDrop.preventDefault).toHaveBeenCalled();
    expect(onDropFiles).not.toHaveBeenCalled();

    act(() => {
      dragDropListener?.({
        payload: {
          type: "drop",
          position: { x: 500, y: 500 },
          paths: ["/Users/test/report.pdf"],
        },
      });
    });

    expect(onDropPaths).toHaveBeenCalledWith(["/Users/test/report.pdf"]);
    expect(onDropFiles).not.toHaveBeenCalled();

    unmount();
    cleanup();
  });

  it("ignores native drops outside the target after native drag moves away", async () => {
    const { targetRef, cleanup } = createDropTarget();
    const onDropFiles = vi.fn();
    const onDropPaths = vi.fn();

    const { unmount } = renderHook(() =>
      useAttachmentDropTarget({
        disabled: false,
        targetRef,
        onDropFiles,
        onDropPaths,
      }),
    );

    await waitFor(() => expect(dragDropListener).not.toBeNull());

    act(() => {
      dragDropListener?.({
        payload: {
          type: "over",
          position: { x: 10, y: 10 },
          paths: ["/Users/test/report.pdf"],
        },
      });
    });

    act(() => {
      dragDropListener?.({
        payload: {
          type: "over",
          position: { x: 500, y: 500 },
          paths: ["/Users/test/report.pdf"],
        },
      });
    });

    act(() => {
      dragDropListener?.({
        payload: {
          type: "drop",
          position: { x: 500, y: 500 },
          paths: ["/Users/test/report.pdf"],
        },
      });
    });

    expect(onDropPaths).not.toHaveBeenCalled();
    expect(onDropFiles).not.toHaveBeenCalled();

    unmount();
    cleanup();
  });

  it("keeps the native Tauri listener subscribed across callback identity changes", async () => {
    const { targetRef, cleanup } = createDropTarget();
    const firstOnDropFiles = vi.fn();
    const firstOnDropPaths = vi.fn();
    const secondOnDropFiles = vi.fn();
    const secondOnDropPaths = vi.fn();

    const { result, rerender, unmount } = renderHook(
      ({ onDropFiles, onDropPaths }) =>
        useAttachmentDropTarget({
          disabled: false,
          targetRef,
          onDropFiles,
          onDropPaths,
        }),
      {
        initialProps: {
          onDropFiles: firstOnDropFiles,
          onDropPaths: firstOnDropPaths,
        },
      },
    );

    await waitFor(() => expect(dragDropListener).not.toBeNull());
    const activeListener = dragDropListener;

    act(() => {
      activeListener?.({
        payload: {
          type: "over",
          position: { x: 10, y: 10 },
          paths: ["/Users/test/report.pdf"],
        },
      });
    });

    expect(result.current.isAttachmentDragOver).toBe(true);

    rerender({
      onDropFiles: secondOnDropFiles,
      onDropPaths: secondOnDropPaths,
    });

    act(() => {
      activeListener?.({
        payload: {
          type: "drop",
          position: { x: 10, y: 10 },
          paths: ["/Users/test/report.pdf"],
        },
      });
    });

    expect(mockOnDragDropEvent).toHaveBeenCalledTimes(1);
    expect(mockUnlisten).not.toHaveBeenCalled();
    expect(firstOnDropFiles).not.toHaveBeenCalled();
    expect(firstOnDropPaths).not.toHaveBeenCalled();
    expect(secondOnDropFiles).not.toHaveBeenCalled();
    expect(secondOnDropPaths).toHaveBeenCalledWith(["/Users/test/report.pdf"]);
    expect(result.current.isAttachmentDragOver).toBe(false);

    unmount();
    cleanup();
  });

  it("uses the latest disabled state and target without resubscribing", async () => {
    const firstTarget = createDropTarget();
    const secondTarget = createDropTarget({
      left: 200,
      top: 200,
      right: 300,
      bottom: 300,
    });
    const onDropPaths = vi.fn();

    const { result, rerender, unmount } = renderHook(
      ({ disabled, targetRef }) =>
        useAttachmentDropTarget({
          disabled,
          targetRef,
          onDropFiles: vi.fn(),
          onDropPaths,
        }),
      {
        initialProps: {
          disabled: false,
          targetRef: firstTarget.targetRef,
        },
      },
    );

    await waitFor(() => expect(dragDropListener).not.toBeNull());

    rerender({ disabled: false, targetRef: secondTarget.targetRef });
    act(() => {
      dragDropListener?.({
        payload: {
          type: "over",
          position: { x: 250, y: 250 },
          paths: ["/Users/test/report.pdf"],
        },
      });
    });
    expect(result.current.isAttachmentDragOver).toBe(true);

    rerender({ disabled: true, targetRef: secondTarget.targetRef });
    act(() => {
      dragDropListener?.({
        payload: {
          type: "drop",
          position: { x: 250, y: 250 },
          paths: ["/Users/test/report.pdf"],
        },
      });
    });

    expect(mockOnDragDropEvent).toHaveBeenCalledTimes(1);
    expect(onDropPaths).not.toHaveBeenCalled();
    expect(result.current.isAttachmentDragOver).toBe(false);

    unmount();
    firstTarget.cleanup();
    secondTarget.cleanup();
  });

  it("uses the latest DOM drop callback without resubscribing", async () => {
    const { targetRef, cleanup } = createDropTarget();
    const firstOnDropFiles = vi.fn();
    const secondOnDropFiles = vi.fn();

    const { result, rerender, unmount } = renderHook(
      ({ onDropFiles }) =>
        useAttachmentDropTarget({
          disabled: false,
          targetRef,
          onDropFiles,
          onDropPaths: vi.fn(),
        }),
      { initialProps: { onDropFiles: firstOnDropFiles } },
    );

    await waitFor(() => expect(dragDropListener).not.toBeNull());
    rerender({ onDropFiles: secondOnDropFiles });

    const file = new File(["pdf"], "report.pdf", {
      type: "application/pdf",
    });
    act(() => {
      result.current.handleDrop(createDomDropEvent(file));
    });

    expect(mockOnDragDropEvent).toHaveBeenCalledTimes(1);
    expect(firstOnDropFiles).not.toHaveBeenCalled();
    expect(secondOnDropFiles).toHaveBeenCalledWith([file]);

    unmount();
    cleanup();
  });

  it("uses the latest committed callback without exposing a suspended render", async () => {
    const { targetRef, cleanup } = createDropTarget();
    const firstOnDropPaths = vi.fn();
    const suspendedOnDropPaths = vi.fn();
    const neverResolves = new Promise<never>(() => {});

    function Wrapper({ children }: PropsWithChildren) {
      return createElement(Suspense, { fallback: null }, children);
    }

    const { result, rerender, unmount } = renderHook(
      ({ onDropPaths, suspend }) => {
        useAttachmentDropTarget({
          disabled: false,
          targetRef,
          onDropFiles: vi.fn(),
          onDropPaths,
        });
        if (suspend) {
          throw neverResolves;
        }
      },
      {
        initialProps: {
          onDropPaths: firstOnDropPaths,
          suspend: false,
        },
        wrapper: Wrapper,
      },
    );

    await waitFor(() => expect(dragDropListener).not.toBeNull());

    act(() => {
      dragDropListener?.({
        payload: {
          type: "over",
          position: { x: 10, y: 10 },
          paths: ["/Users/test/report.pdf"],
        },
      });
    });

    rerender({
      onDropPaths: suspendedOnDropPaths,
      suspend: true,
    });

    act(() => {
      dragDropListener?.({
        payload: {
          type: "drop",
          position: { x: 10, y: 10 },
          paths: ["/Users/test/report.pdf"],
        },
      });
    });

    expect(firstOnDropPaths).toHaveBeenCalledWith(["/Users/test/report.pdf"]);
    expect(suspendedOnDropPaths).not.toHaveBeenCalled();
    expect(result.current).toBeUndefined();

    unmount();
    cleanup();
  });

  it("keeps handling native drops during the async registration gap a resubscribe would create", async () => {
    const { targetRef, cleanup } = createDropTarget();
    const firstOnDropFiles = vi.fn();
    const firstOnDropPaths = vi.fn();
    const secondOnDropFiles = vi.fn();
    const secondOnDropPaths = vi.fn();
    let registrations = 0;

    mockUnlisten.mockImplementation(() => {
      dragDropListener = null;
    });
    mockOnDragDropEvent.mockImplementation(
      (listener: NativeDragDropListener): Promise<() => void> => {
        registrations += 1;
        if (registrations === 1) {
          dragDropListener = listener;
          return Promise.resolve(mockUnlisten);
        }
        return new Promise(() => {
          // Leave replacement registration pending to model Tauri's async gap.
        });
      },
    );

    const { result, rerender, unmount } = renderHook(
      ({ onDropFiles, onDropPaths }) =>
        useAttachmentDropTarget({
          disabled: false,
          targetRef,
          onDropFiles,
          onDropPaths,
        }),
      {
        initialProps: {
          onDropFiles: firstOnDropFiles,
          onDropPaths: firstOnDropPaths,
        },
      },
    );

    await waitFor(() => expect(dragDropListener).not.toBeNull());
    await act(async () => {
      await Promise.resolve();
    });
    const activeListener = dragDropListener;

    act(() => {
      activeListener?.({
        payload: {
          type: "over",
          position: { x: 10, y: 10 },
          paths: ["/Users/test/report.pdf"],
        },
      });
    });

    expect(result.current.isAttachmentDragOver).toBe(true);

    rerender({
      onDropFiles: secondOnDropFiles,
      onDropPaths: secondOnDropPaths,
    });

    expect(dragDropListener).toBe(activeListener);
    act(() => {
      dragDropListener?.({
        payload: {
          type: "drop",
          position: { x: 10, y: 10 },
          paths: ["/Users/test/report.pdf"],
        },
      });
    });

    expect(mockOnDragDropEvent).toHaveBeenCalledTimes(1);
    expect(mockUnlisten).not.toHaveBeenCalled();
    expect(firstOnDropFiles).not.toHaveBeenCalled();
    expect(firstOnDropPaths).not.toHaveBeenCalled();
    expect(secondOnDropFiles).not.toHaveBeenCalled();
    expect(secondOnDropPaths).toHaveBeenCalledWith(["/Users/test/report.pdf"]);
    expect(result.current.isAttachmentDragOver).toBe(false);

    unmount();
    expect(mockUnlisten).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("clears rejected native drops before the next valid DOM drop", async () => {
    const { targetRef, cleanup } = createDropTarget();
    const onDropFiles = vi.fn();

    const { result, unmount } = renderHook(() =>
      useAttachmentDropTarget({
        disabled: false,
        targetRef,
        onDropFiles,
        onDropPaths: vi.fn(),
      }),
    );

    await waitFor(() => expect(dragDropListener).not.toBeNull());

    act(() => {
      dragDropListener?.({
        payload: {
          type: "over",
          position: { x: 10, y: 10 },
          paths: ["/Users/test/report.pdf"],
        },
      });
    });
    expect(result.current.isAttachmentDragOver).toBe(true);

    act(() => {
      dragDropListener?.({
        payload: {
          type: "drop",
          position: { x: 10, y: 10 },
          paths: [],
        },
      });
    });
    expect(result.current.isAttachmentDragOver).toBe(false);

    const file = new File(["pdf"], "report.pdf", {
      type: "application/pdf",
    });
    act(() => {
      result.current.handleDrop(createDomDropEvent(file));
    });
    expect(onDropFiles).toHaveBeenCalledWith([file]);

    unmount();
    cleanup();
  });

  it("does not register a native listener when unmounted before import resolves", async () => {
    const { targetRef, cleanup } = createDropTarget();

    const { unmount } = renderHook(() =>
      useAttachmentDropTarget({
        disabled: false,
        targetRef,
        onDropFiles: vi.fn(),
        onDropPaths: vi.fn(),
      }),
    );

    unmount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockOnDragDropEvent).not.toHaveBeenCalled();
    cleanup();
  });

  it("unlistens when native registration resolves after unmount", async () => {
    const { targetRef, cleanup } = createDropTarget();
    const onDropFiles = vi.fn();
    const onDropPaths = vi.fn();
    let resolveRegistration: ((unlisten: () => void) => void) | null = null;

    mockOnDragDropEvent.mockImplementation(
      (listener: NativeDragDropListener): Promise<() => void> => {
        dragDropListener = listener;
        return new Promise((resolve) => {
          resolveRegistration = resolve;
        });
      },
    );

    const { unmount } = renderHook(() =>
      useAttachmentDropTarget({
        disabled: false,
        targetRef,
        onDropFiles,
        onDropPaths,
      }),
    );

    await waitFor(() => expect(dragDropListener).not.toBeNull());
    unmount();
    expect(mockUnlisten).not.toHaveBeenCalled();

    await act(async () => {
      resolveRegistration?.(mockUnlisten);
      await Promise.resolve();
    });

    expect(mockUnlisten).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("keeps the DOM file fallback when no native Tauri drag was seen", async () => {
    const { targetRef, cleanup } = createDropTarget();
    const onDropFiles = vi.fn();
    const onDropPaths = vi.fn();

    const { result, unmount } = renderHook(() =>
      useAttachmentDropTarget({
        disabled: false,
        targetRef,
        onDropFiles,
        onDropPaths,
      }),
    );

    await waitFor(() => expect(dragDropListener).not.toBeNull());

    const file = new File(["pdf"], "report.pdf", {
      type: "application/pdf",
    });
    const domDrop = createDomDropEvent(file);
    act(() => {
      result.current.handleDrop(domDrop);
    });

    expect(domDrop.preventDefault).toHaveBeenCalled();
    expect(onDropFiles).toHaveBeenCalledWith([file]);
    expect(onDropPaths).not.toHaveBeenCalled();

    unmount();
    cleanup();
  });

  it("ignores internal app drags even if they pass over the attachment target", async () => {
    const { targetRef, cleanup } = createDropTarget();
    const onDropFiles = vi.fn();
    const onDropPaths = vi.fn();

    const { result, unmount } = renderHook(() =>
      useAttachmentDropTarget({
        disabled: false,
        targetRef,
        onDropFiles,
        onDropPaths,
      }),
    );

    const dragEnterEvent = createInternalDragEvent();
    act(() => {
      result.current.handleDragEnter(dragEnterEvent);
    });

    expect(dragEnterEvent.preventDefault).toHaveBeenCalled();
    expect(result.current.isAttachmentDragOver).toBe(false);

    const dropEvent = createInternalDragEvent();
    act(() => {
      result.current.handleDrop(dropEvent);
    });

    expect(dropEvent.preventDefault).toHaveBeenCalled();
    expect(onDropFiles).not.toHaveBeenCalled();
    expect(onDropPaths).not.toHaveBeenCalled();

    unmount();
    cleanup();
  });

  it("ignores native Tauri drag events while an internal app drag is active", async () => {
    const { targetRef, cleanup } = createDropTarget();
    const onDropFiles = vi.fn();
    const onDropPaths = vi.fn();

    const { result, unmount } = renderHook(() =>
      useAttachmentDropTarget({
        disabled: false,
        targetRef,
        onDropFiles,
        onDropPaths,
      }),
    );

    await waitFor(() => expect(dragDropListener).not.toBeNull());

    document.documentElement.dataset.gooseInternalDrag = "project-chat";
    act(() => {
      dragDropListener?.({
        payload: {
          type: "over",
          position: { x: 10, y: 10 },
          paths: ["/Users/test/report.pdf"],
        },
      });
    });

    expect(result.current.isAttachmentDragOver).toBe(false);

    act(() => {
      dragDropListener?.({
        payload: {
          type: "drop",
          position: { x: 10, y: 10 },
          paths: ["/Users/test/report.pdf"],
        },
      });
    });

    expect(onDropFiles).not.toHaveBeenCalled();
    expect(onDropPaths).not.toHaveBeenCalled();

    unmount();
    cleanup();
  });

  it("can bind DOM drop events to a larger external target", async () => {
    const { target, targetRef, cleanup } = createDropTarget();
    const onDropFiles = vi.fn();
    const onDropPaths = vi.fn();

    const { result, unmount } = renderHook(() =>
      useAttachmentDropTarget({
        disabled: false,
        targetRef,
        bindTargetEvents: true,
        onDropFiles,
        onDropPaths,
      }),
    );

    await waitFor(() => expect(dragDropListener).not.toBeNull());

    const file = new File(["pdf"], "report.pdf", {
      type: "application/pdf",
    });
    const dataTransfer = {
      files: [file],
      items: [{ kind: "file" }],
      types: ["Files"],
      dropEffect: "copy",
    } as unknown as DataTransfer;

    const dragEnterEvent = new Event("dragenter", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(dragEnterEvent, "dataTransfer", {
      configurable: true,
      value: dataTransfer,
    });
    act(() => {
      target.dispatchEvent(dragEnterEvent);
    });
    expect(result.current.isAttachmentDragOver).toBe(true);

    const dropEvent = new Event("drop", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(dropEvent, "dataTransfer", {
      configurable: true,
      value: dataTransfer,
    });
    act(() => {
      target.dispatchEvent(dropEvent);
    });

    expect(dropEvent.defaultPrevented).toBe(true);
    expect(onDropFiles).toHaveBeenCalledWith([file]);
    expect(onDropPaths).not.toHaveBeenCalled();
    expect(result.current.isAttachmentDragOver).toBe(false);

    unmount();
    cleanup();
  });

  it("preserves an expected native drop when a target DOM drop bubbles to document", async () => {
    const { target, targetRef, cleanup } = createDropTarget();
    const onDropFiles = vi.fn();
    const onDropPaths = vi.fn();

    const { unmount } = renderHook(() =>
      useAttachmentDropTarget({
        disabled: false,
        targetRef,
        bindTargetEvents: true,
        onDropFiles,
        onDropPaths,
      }),
    );

    await waitFor(() => expect(dragDropListener).not.toBeNull());

    act(() => {
      dragDropListener?.({
        payload: {
          type: "over",
          position: { x: 10, y: 10 },
          paths: ["/Users/test/report.pdf"],
        },
      });
    });

    const dataTransfer = {
      files: [
        new File(["pdf"], "report.pdf", {
          type: "application/pdf",
        }),
      ],
      items: [{ kind: "file" }],
      types: ["Files"],
      dropEffect: "copy",
    } as unknown as DataTransfer;
    const domDropEvent = new Event("drop", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(domDropEvent, "dataTransfer", {
      configurable: true,
      value: dataTransfer,
    });

    act(() => {
      target.dispatchEvent(domDropEvent);
    });

    act(() => {
      dragDropListener?.({
        payload: {
          type: "drop",
          position: { x: 500, y: 500 },
          paths: ["/Users/test/report.pdf"],
        },
      });
    });

    expect(onDropPaths).toHaveBeenCalledWith(["/Users/test/report.pdf"]);
    expect(onDropFiles).not.toHaveBeenCalled();

    unmount();
    cleanup();
  });

  it("resets the overlay when Escape is pressed while drag is active", async () => {
    const { targetRef, cleanup } = createDropTarget();
    const onDropFiles = vi.fn();
    const onDropPaths = vi.fn();

    const { result, unmount } = renderHook(() =>
      useAttachmentDropTarget({
        disabled: false,
        targetRef,
        onDropFiles,
        onDropPaths,
      }),
    );

    await waitFor(() => expect(dragDropListener).not.toBeNull());

    // Simulate a native drag over the target to activate the overlay
    act(() => {
      dragDropListener?.({
        payload: {
          type: "over",
          position: { x: 10, y: 10 },
          paths: ["/Users/test/file.txt"],
        },
      });
    });

    expect(result.current.isAttachmentDragOver).toBe(true);

    // Press Escape — the overlay should dismiss
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    expect(result.current.isAttachmentDragOver).toBe(false);

    unmount();
    cleanup();
  });

  it("resets the overlay when the window loses focus during a drag", async () => {
    const { targetRef, cleanup } = createDropTarget();
    const onDropFiles = vi.fn();
    const onDropPaths = vi.fn();

    const { result, unmount } = renderHook(() =>
      useAttachmentDropTarget({
        disabled: false,
        targetRef,
        onDropFiles,
        onDropPaths,
      }),
    );

    await waitFor(() => expect(dragDropListener).not.toBeNull());

    // Simulate a native drag over the target
    act(() => {
      dragDropListener?.({
        payload: {
          type: "over",
          position: { x: 10, y: 10 },
          paths: ["/Users/test/file.txt"],
        },
      });
    });

    expect(result.current.isAttachmentDragOver).toBe(true);

    // Window blur — the overlay should dismiss
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(result.current.isAttachmentDragOver).toBe(false);

    unmount();
    cleanup();
  });

  it("resets the overlay when a file is dropped outside the target", async () => {
    const { targetRef, cleanup } = createDropTarget();
    const onDropFiles = vi.fn();
    const onDropPaths = vi.fn();

    const { result, unmount } = renderHook(() =>
      useAttachmentDropTarget({
        disabled: false,
        targetRef,
        onDropFiles,
        onDropPaths,
      }),
    );

    await waitFor(() => expect(dragDropListener).not.toBeNull());

    const file = new File(["text"], "notes.txt", { type: "text/plain" });
    const dragEnterEvent = createDomDropEvent(file);
    act(() => {
      result.current.handleDragEnter(dragEnterEvent);
    });

    expect(result.current.isAttachmentDragOver).toBe(true);

    const outsideDropEvent = new Event("drop", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(outsideDropEvent, "dataTransfer", {
      configurable: true,
      value: {
        files: [file],
        items: [{ kind: "file" }],
        types: ["Files"],
      },
    });

    act(() => {
      document.body.dispatchEvent(outsideDropEvent);
    });

    expect(result.current.isAttachmentDragOver).toBe(false);
    expect(onDropFiles).not.toHaveBeenCalled();
    expect(onDropPaths).not.toHaveBeenCalled();

    unmount();
    cleanup();
  });

  it("resets the overlay via watchdog if native drag events stop arriving", async () => {
    const { targetRef, cleanup } = createDropTarget();
    const onDropFiles = vi.fn();
    const onDropPaths = vi.fn();

    const { result, unmount } = renderHook(() =>
      useAttachmentDropTarget({
        disabled: false,
        targetRef,
        onDropFiles,
        onDropPaths,
      }),
    );

    await waitFor(() => expect(dragDropListener).not.toBeNull());

    // Switch to fake timers after the async listener is registered
    vi.useFakeTimers();

    // Simulate a native drag over the target
    act(() => {
      dragDropListener?.({
        payload: {
          type: "over",
          position: { x: 10, y: 10 },
          paths: ["/Users/test/file.txt"],
        },
      });
    });

    expect(result.current.isAttachmentDragOver).toBe(true);

    // Advance time past the watchdog threshold (3000ms)
    act(() => {
      vi.advanceTimersByTime(3500);
    });

    expect(result.current.isAttachmentDragOver).toBe(false);

    unmount();
    cleanup();
    vi.useRealTimers();
  });

  it("clears the watchdog when Escape resets the overlay", async () => {
    const { targetRef, cleanup } = createDropTarget();
    const onDropFiles = vi.fn();
    const onDropPaths = vi.fn();

    const { result, unmount } = renderHook(() =>
      useAttachmentDropTarget({
        disabled: false,
        targetRef,
        onDropFiles,
        onDropPaths,
      }),
    );

    await waitFor(() => expect(dragDropListener).not.toBeNull());

    vi.useFakeTimers();

    act(() => {
      dragDropListener?.({
        payload: {
          type: "over",
          position: { x: 10, y: 10 },
          paths: ["/Users/test/file.txt"],
        },
      });
    });

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    expect(result.current.isAttachmentDragOver).toBe(false);

    act(() => {
      vi.advanceTimersByTime(2500);
      dragDropListener?.({
        payload: {
          type: "over",
          position: { x: 10, y: 10 },
          paths: ["/Users/test/next-file.txt"],
        },
      });
    });

    expect(result.current.isAttachmentDragOver).toBe(true);

    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(result.current.isAttachmentDragOver).toBe(true);

    unmount();
    cleanup();
    vi.useRealTimers();
  });
});
