import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAttachmentDropTarget } from "../useAttachmentDropTarget";

let dragDropListener:
  | ((event: {
      payload:
        | { type: "leave"; position: { x: number; y: number } }
        | { type: "drop"; position: { x: number; y: number }; paths: string[] }
        | { type: "over"; position: { x: number; y: number }; paths: string[] };
    }) => void)
  | null = null;
const mockUnlisten = vi.fn();

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn((listener) => {
      dragDropListener = listener;
      return Promise.resolve(mockUnlisten);
    }),
  }),
}));

function createDropTarget() {
  const target = document.createElement("div");
  document.body.appendChild(target);
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: 100,
    bottom: 100,
    width: 100,
    height: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn((x: number, y: number) =>
      x >= 0 && x <= 100 && y >= 0 && y <= 100 ? target : null,
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
