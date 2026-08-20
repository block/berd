import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const nativeDropMocks = vi.hoisted(() => ({
  listener: null as ((event: { payload: unknown }) => void) | null,
  readImportAgentFile: vi.fn(),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (listener: (event: { payload: unknown }) => void) => {
      nativeDropMocks.listener = listener;
      return Promise.resolve(() => {
        nativeDropMocks.listener = null;
      });
    },
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ scaleFactor: () => Promise.resolve(2) }),
}));

vi.mock("@/shared/api/agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/api/agents")>()),
  readImportAgentFile: nativeDropMocks.readImportAgentFile,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
import {
  AgentImportDialog,
  type AgentImportPreview,
} from "../AgentImportDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { resolvedLanguage: "en", language: "en" },
  }),
}));

vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  return { ...actual, useReducedMotion: () => false };
});

function importDialogProps(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    onOpenChange: vi.fn(),
    onImportFile: vi.fn(),
    prepareImport: () => ({
      displayName: "Reviewer",
      systemPrompt: "Review carefully.",
      identity: "agent.agent.png",
    }),
    validateImportFile: () => null,
    onImportError: vi.fn(),
    maxImportBytes: 1024,
    importTooLargeMessage: "Too large",
    ...overrides,
  };
}

describe("AgentImportDialog", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    nativeDropMocks.listener = null;
    nativeDropMocks.readImportAgentFile.mockReset();
  });

  it("waits for a native drop and ignores stale reads", async () => {
    window.__TAURI_INTERNALS__ = {} as typeof window.__TAURI_INTERNALS__;
    const first = deferred<{ fileBytes: number[]; fileName: string }>();
    const second = deferred<{ fileBytes: number[]; fileName: string }>();
    nativeDropMocks.readImportAgentFile
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const prepareImport = vi.fn(() => ({
      displayName: "Reviewer",
      systemPrompt: "Review carefully.",
      identity: "agent.agent.png",
    }));
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn().mockReturnValue(null),
    });
    render(<AgentImportDialog {...importDialogProps({ prepareImport })} />);
    await waitFor(() => expect(nativeDropMocks.listener).not.toBeNull());
    const position = { x: 0, y: 0, toLogical: () => ({ x: 0, y: 0 }) };

    act(() =>
      nativeDropMocks.listener?.({
        payload: { type: "enter", paths: ["first.zip"], position },
      }),
    );
    expect(nativeDropMocks.readImportAgentFile).not.toHaveBeenCalled();
    const inaccurateDropPosition = {
      x: 4000,
      y: 4000,
      toLogical: () => ({ x: 2000, y: 2000 }),
    };
    act(() =>
      nativeDropMocks.listener?.({
        payload: {
          type: "drop",
          paths: ["first.zip"],
          position: inaccurateDropPosition,
        },
      }),
    );
    act(() =>
      nativeDropMocks.listener?.({
        payload: { type: "drop", paths: ["second.zip"], position },
      }),
    );
    second.resolve({ fileBytes: [2], fileName: "second.zip" });
    await waitFor(() =>
      expect(prepareImport).toHaveBeenCalledWith(
        expect.any(Uint8Array),
        "second.zip",
        expect.any(AbortSignal),
      ),
    );
    first.resolve({ fileBytes: [1], fileName: "first.zip" });
    await act(async () => {});
    expect(prepareImport).toHaveBeenCalledTimes(1);
  });

  it("ignores a native read that resolves after unmount", async () => {
    window.__TAURI_INTERNALS__ = {} as typeof window.__TAURI_INTERNALS__;
    const read = deferred<{ fileBytes: number[]; fileName: string }>();
    nativeDropMocks.readImportAgentFile.mockReturnValue(read.promise);
    const prepareImport = vi.fn(() => ({
      displayName: "Reviewer",
      systemPrompt: "Review carefully.",
      identity: "agent.agent.png",
    }));
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn().mockReturnValue(null),
    });
    const { unmount } = render(
      <AgentImportDialog {...importDialogProps({ prepareImport })} />,
    );
    await waitFor(() => expect(nativeDropMocks.listener).not.toBeNull());
    const position = { x: 0, y: 0 };
    act(() =>
      nativeDropMocks.listener?.({
        payload: { type: "drop", paths: ["agent.png"], position },
      }),
    );
    unmount();
    read.resolve({ fileBytes: [1], fileName: "agent.png" });
    await act(async () => {});

    expect(prepareImport).not.toHaveBeenCalled();
  });

  it("clears a prepared import when a replacement file is rejected", async () => {
    const firstBytes = Uint8Array.from([1, 2, 3]);
    const firstFile = new File([firstBytes], "agent.agent.png", {
      type: "image/png",
    });
    Object.defineProperty(firstFile, "arrayBuffer", {
      configurable: true,
      value: vi.fn().mockResolvedValue(firstBytes.buffer),
    });
    const rejectedFile = new File([new Uint8Array([9])], "broken.zip", {
      type: "application/zip",
    });
    const onImportError = vi.fn();
    render(
      <AgentImportDialog
        {...importDialogProps({
          validateImportFile: (file: File) =>
            file.name === "broken.zip" ? "Invalid ZIP" : null,
          onImportError,
        })}
      />,
    );
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]');

    fireEvent.change(input as HTMLInputElement, {
      target: { files: [firstFile] },
    });
    expect(
      await screen.findByRole("button", { name: "importDialog.import" }),
    ).toBeInTheDocument();

    fireEvent.change(input as HTMLInputElement, {
      target: { files: [rejectedFile] },
    });

    expect(onImportError).toHaveBeenCalledWith("Invalid ZIP");
    expect(
      screen.queryByRole("button", { name: "importDialog.import" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Reviewer")).not.toBeInTheDocument();
  });

  it("revokes the preview URL of an aborted preparation result", async () => {
    const revokeSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const preparation = deferred<{
      bytes: Uint8Array;
      name: string;
      preview: AgentImportPreview;
    }>();
    const bytes = Uint8Array.from([1]);
    const file = new File([bytes], "agent.zip", { type: "application/zip" });
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: vi.fn().mockResolvedValue(bytes.buffer),
    });
    let preparationSignal: AbortSignal | undefined;
    const props = importDialogProps({
      prepareImport: (
        _bytes: Uint8Array,
        _name: string,
        signal: AbortSignal,
      ) => {
        preparationSignal = signal;
        return preparation.promise;
      },
    });
    const { rerender } = render(<AgentImportDialog {...props} />);
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });
    await waitFor(() => expect(preparationSignal).toBeDefined());

    // Close aborts the preparation before its result lands.
    rerender(<AgentImportDialog {...props} open={false} />);
    expect(preparationSignal?.aborted).toBe(true);

    // The aborted result carries a blob URL that no state will ever own.
    await act(async () => {
      preparation.resolve({
        bytes,
        name: "stale.agent.png",
        preview: {
          displayName: "Stale",
          systemPrompt: "Stale",
          identity: "stale.agent.png",
          cardImageUrl: "blob:stale-card",
        },
      });
    });

    expect(revokeSpy).toHaveBeenCalledWith("blob:stale-card");
    expect(screen.queryByText("Stale")).not.toBeInTheDocument();
    revokeSpy.mockRestore();
  });

  it("cancels in-flight preparation when the dialog closes", async () => {
    const preparation = deferred<{
      bytes: Uint8Array;
      name: string;
      preview: AgentImportPreview;
    }>();
    const bytes = Uint8Array.from([1]);
    const file = new File([bytes], "agent.zip", { type: "application/zip" });
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: vi.fn().mockResolvedValue(bytes.buffer),
    });
    let preparationSignal: AbortSignal | undefined;
    const props = importDialogProps({
      prepareImport: (
        _bytes: Uint8Array,
        _name: string,
        signal: AbortSignal,
      ) => {
        preparationSignal = signal;
        return preparation.promise;
      },
    });
    const { rerender } = render(<AgentImportDialog {...props} />);
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });
    await waitFor(() => expect(preparationSignal).toBeDefined());

    // Pending preparation announces busy status and localized progress copy
    // in both the drop-zone status text and the loading button label.
    expect(
      screen.getAllByText("importDialog.preparing").length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");

    rerender(<AgentImportDialog {...props} open={false} />);
    expect(preparationSignal?.aborted).toBe(true);

    await act(async () => {
      preparation.resolve({
        bytes,
        name: "stale.md",
        preview: {
          displayName: "Stale",
          systemPrompt: "Stale",
          identity: "stale.md",
        },
      });
    });
    expect(screen.queryByText("Stale")).not.toBeInTheDocument();
  });

  it("shows authored public copy instead of private instructions", async () => {
    const bytes = Uint8Array.from([1]);
    const file = new File([bytes], "agent.md", { type: "text/markdown" });
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: vi.fn().mockResolvedValue(bytes.buffer),
    });
    render(
      <AgentImportDialog
        {...importDialogProps({
          prepareImport: () => ({
            displayName: "Scout",
            description: "Finds relevant evidence.",
            systemPrompt: "Never disclose customer identities.",
            identity: "agent.md",
          }),
        })}
      />,
    );

    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });

    await waitFor(() =>
      expect(document.body.textContent).toContain("Finds relevant evidence."),
    );
    expect(document.body.textContent).not.toContain(
      "Never disclose customer identities.",
    );
  });

  it("uses a generic fallback when public import copy is absent", async () => {
    const bytes = Uint8Array.from([1]);
    const file = new File([bytes], "agent.md", { type: "text/markdown" });
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: vi.fn().mockResolvedValue(bytes.buffer),
    });
    render(
      <AgentImportDialog
        {...importDialogProps({
          prepareImport: () => ({
            displayName: "Scout",
            systemPrompt: "Never disclose customer identities.",
            identity: "agent.md",
          }),
        })}
      />,
    );

    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "importDialog.descriptionFallback",
      ),
    );
    expect(document.body.textContent).not.toContain(
      "Never disclose customer identities.",
    );
  });

  it("tilts the rendered import card toward the pointer and resets", async () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: false,
    } as MediaQueryList);
    const fileBytes = Uint8Array.from([1, 2, 3]);
    const file = new File([fileBytes], "agent.agent.png", {
      type: "image/png",
    });
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: vi.fn().mockResolvedValue(fileBytes.buffer),
    });
    render(
      <AgentImportDialog
        open
        onOpenChange={vi.fn()}
        onImportFile={vi.fn()}
        prepareImport={() => ({
          displayName: "Reviewer",
          systemPrompt: "Review carefully.",
          identity: "agent.agent.png",
          cardImageUrl: "blob:card",
          cardAspectRatio: 1 / 8192,
        })}
        validateImportFile={() => null}
        onImportError={vi.fn()}
        maxImportBytes={1024}
        importTooLargeMessage="Too large"
      />,
    );
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });
    const image = await screen.findByRole("img", {
      name: "importDialog.previewAlt",
    });
    const tiltSurface = image.closest<HTMLDivElement>(
      '[data-agent-card-surface="true"]',
    ) as HTMLDivElement;
    const reveal = tiltSurface.closest<HTMLDivElement>(
      '[data-agent-card-reveal="true"]',
    );
    const revealContent = reveal?.querySelector<HTMLDivElement>(
      '[data-agent-card-reveal-content="true"]',
    );
    expect(revealContent?.className).toContain("z-10");
    expect(tiltSurface.style.aspectRatio).toBe("");
    expect(image).toHaveClass("object-contain");
    expect(
      tiltSurface.querySelector('canvas[data-agent-card-frame-only="true"]'),
    ).not.toBeNull();
    vi.spyOn(tiltSurface, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 100,
      height: 200,
    } as DOMRect);

    const move = createEvent.pointerMove(tiltSurface);
    Object.defineProperties(move, {
      clientX: { value: 100 },
      clientY: { value: 0 },
    });
    fireEvent(tiltSurface, move);
    await waitFor(() =>
      expect(tiltSurface.style.transform).toBe("rotateX(8deg) rotateY(8deg)"),
    );

    fireEvent.pointerLeave(tiltSurface);
    expect(tiltSurface.style.transform).toBe("none");
  });
});
