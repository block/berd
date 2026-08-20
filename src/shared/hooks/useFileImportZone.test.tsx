import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useFileImportZone } from "./useFileImportZone";

function pngFile(name = "agent.agent.png"): File {
  const bytes = Uint8Array.from([137, 80, 78, 71]);
  const file = new File([bytes], name, { type: "image/png" });
  Object.defineProperty(file, "arrayBuffer", {
    configurable: true,
    value: vi.fn().mockResolvedValue(bytes.buffer),
  });
  return file;
}

describe("useFileImportZone", () => {
  it("reads and imports a dropped file", async () => {
    const onImportFile = vi.fn();
    const { result } = renderHook(() => useFileImportZone({ onImportFile }));
    const file = pngFile();

    act(() => {
      result.current.dropHandlers.onDrop({
        preventDefault: vi.fn(),
        dataTransfer: { files: [file] },
      } as unknown as React.DragEvent);
    });

    await waitFor(() =>
      expect(onImportFile).toHaveBeenCalledWith(
        Uint8Array.from([137, 80, 78, 71]),
        "agent.agent.png",
      ),
    );
  });

  it("rejects an invalid dropped file without reading or importing it", async () => {
    const onImportFile = vi.fn();
    const onImportError = vi.fn();
    const file = pngFile("ordinary.png");
    const arrayBuffer = vi.spyOn(file, "arrayBuffer");
    const { result } = renderHook(() =>
      useFileImportZone({
        onImportFile,
        onImportError,
        validateFile: () => "Not an agent image",
      }),
    );

    act(() => {
      result.current.dropHandlers.onDrop({
        preventDefault: vi.fn(),
        dataTransfer: { files: [file] },
      } as unknown as React.DragEvent);
    });

    await waitFor(() =>
      expect(onImportError).toHaveBeenCalledWith("Not an agent image"),
    );
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(onImportFile).not.toHaveBeenCalled();
  });

  it("keeps only the latest overlapping file read", async () => {
    const onImportFile = vi.fn();
    let resolveFirst: ((value: ArrayBuffer) => void) | undefined;
    const first = pngFile("first.png");
    Object.defineProperty(first, "arrayBuffer", {
      configurable: true,
      value: vi.fn(
        () =>
          new Promise<ArrayBuffer>((resolve) => {
            resolveFirst = resolve;
          }),
      ),
    });
    const second = pngFile("second.png");
    const { result } = renderHook(() => useFileImportZone({ onImportFile }));

    act(() => {
      result.current.dropHandlers.onDrop({
        preventDefault: vi.fn(),
        dataTransfer: { files: [first] },
      } as unknown as React.DragEvent);
      result.current.dropHandlers.onDrop({
        preventDefault: vi.fn(),
        dataTransfer: { files: [second] },
      } as unknown as React.DragEvent);
    });

    await waitFor(() =>
      expect(onImportFile).toHaveBeenCalledWith(
        expect.any(Uint8Array),
        "second.png",
      ),
    );
    resolveFirst?.(Uint8Array.from([1]).buffer);
    await Promise.resolve();
    expect(onImportFile).toHaveBeenCalledTimes(1);
  });

  it("allows another ingress path to invalidate a pending file read", async () => {
    const onImportFile = vi.fn();
    let resolveRead: ((value: ArrayBuffer) => void) | undefined;
    const file = pngFile("picker.png");
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: vi.fn(
        () =>
          new Promise<ArrayBuffer>((resolve) => {
            resolveRead = resolve;
          }),
      ),
    });
    const { result } = renderHook(() => useFileImportZone({ onImportFile }));

    act(() => {
      void result.current.importFile(file);
      result.current.invalidateImport();
    });
    resolveRead?.(Uint8Array.from([1]).buffer);
    await act(async () => {});

    expect(onImportFile).not.toHaveBeenCalled();
  });

  it("reports file read failures", async () => {
    const onImportFile = vi.fn();
    const onImportError = vi.fn();
    const file = pngFile();
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: vi.fn().mockRejectedValue(new Error("Read failed")),
    });
    const { result } = renderHook(() =>
      useFileImportZone({ onImportFile, onImportError }),
    );

    act(() => {
      result.current.dropHandlers.onDrop({
        preventDefault: vi.fn(),
        dataTransfer: { files: [file] },
      } as unknown as React.DragEvent);
    });

    await waitFor(() =>
      expect(onImportError).toHaveBeenCalledWith("Read failed"),
    );
    expect(onImportFile).not.toHaveBeenCalled();
  });

  it("rejects an oversized file before reading it", async () => {
    const onImportFile = vi.fn();
    const onImportError = vi.fn();
    const file = pngFile();
    Object.defineProperty(file, "size", { value: 11 });
    const arrayBuffer = vi.spyOn(file, "arrayBuffer");
    const { result } = renderHook(() =>
      useFileImportZone({
        onImportFile,
        onImportError,
        maxBytes: 10,
        fileTooLargeMessage: "Too large",
      }),
    );

    act(() => {
      result.current.dropHandlers.onDrop({
        preventDefault: vi.fn(),
        dataTransfer: { files: [file] },
      } as unknown as React.DragEvent);
    });

    await waitFor(() =>
      expect(onImportError).toHaveBeenCalledWith("Too large"),
    );
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(onImportFile).not.toHaveBeenCalled();
  });
});
