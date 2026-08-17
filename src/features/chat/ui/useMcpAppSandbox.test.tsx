import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpAppSandbox } from "@/shared/api/gooseServeHost";
import type { RenderableMcpAppDocument } from "./mcpAppPayload";
import { useMcpAppSandbox } from "./useMcpAppSandbox";

vi.mock("@/shared/api/gooseServeHost", () => ({
  createMcpAppSandbox: vi.fn(),
}));

const mockedCreateMcpAppSandbox = vi.mocked(createMcpAppSandbox);
const onError = vi.fn();
const onPendingChange = vi.fn();
const TRUSTED_IPC_NONCE = "IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII";
const TRUSTED_IPC_NONCE_PROPERTY = "__BERD_MCP_SANDBOX_IPC_NONCE__";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function document(
  resourceUri: string,
  csp: RenderableMcpAppDocument["csp"] = null,
) {
  return { resourceUri, html: `<html>${resourceUri}</html>`, csp };
}

describe("useMcpAppSandbox", () => {
  beforeEach(() => {
    Object.defineProperty(window, TRUSTED_IPC_NONCE_PROPERTY, {
      value: TRUSTED_IPC_NONCE,
      configurable: true,
    });
    mockedCreateMcpAppSandbox.mockReset();
    onError.mockReset();
    onPendingChange.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(window, TRUSTED_IPC_NONCE_PROPERTY, {
      value: TRUSTED_IPC_NONCE,
      configurable: true,
    });
    cleanup();
  });

  it("keeps the sandbox pending signal active across replacement requests", async () => {
    const first = deferred<{ proxyUrl: string }>();
    const second = deferred<{ proxyUrl: string }>();
    mockedCreateMcpAppSandbox
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { rerender } = renderHook(
      ({ renderableDocument }) =>
        useMcpAppSandbox({
          renderableDocument,
          colorScheme: "light",
          onPendingChange,
          onError,
        }),
      {
        initialProps: { renderableDocument: document("ui://example/first") },
      },
    );

    await waitFor(() =>
      expect(mockedCreateMcpAppSandbox).toHaveBeenCalledTimes(1),
    );
    rerender({ renderableDocument: document("ui://example/second") });
    await waitFor(() =>
      expect(mockedCreateMcpAppSandbox).toHaveBeenCalledTimes(2),
    );

    expect(onPendingChange.mock.calls).toEqual([[true], [false], [true]]);
    await act(async () => {
      second.resolve({
        proxyUrl:
          "http://127.0.0.1:4243/mcp-app-sandbox/proxy/SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS#document=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      });
      await second.promise;
    });
  });

  it("fails closed when the trusted top-level IPC nonce is absent", async () => {
    Reflect.deleteProperty(window, TRUSTED_IPC_NONCE_PROPERTY);

    const { result } = renderHook(() =>
      useMcpAppSandbox({
        renderableDocument: document("ui://example/no-ipc-nonce"),
        colorScheme: "light",
        onPendingChange,
        onError,
      }),
    );

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(mockedCreateMcpAppSandbox).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it("passes only document policy and renders a secret-free capability URL", async () => {
    mockedCreateMcpAppSandbox.mockResolvedValue({
      proxyUrl:
        "http://127.0.0.1:4243/mcp-app-sandbox/proxy/OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO#document=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    });
    const renderableDocument = document("ui://example/app", {
      connectDomains: ["https://api.example"],
      resourceDomains: ["https://cdn.example"],
      frameDomains: ["https://frame.example"],
      baseUriDomains: ["https://base.example"],
      scriptDomains: ["https://script.example"],
    });

    const { result } = renderHook(() =>
      useMcpAppSandbox({
        renderableDocument,
        colorScheme: "dark",
        onPendingChange,
        onError,
      }),
    );

    await waitFor(() => expect(result.current).not.toBeNull());
    expect(mockedCreateMcpAppSandbox).toHaveBeenCalledWith({
      connectDomains: ["https://api.example"],
      resourceDomains: ["https://cdn.example"],
      frameDomains: ["https://frame.example"],
      baseUriDomains: ["https://base.example"],
      scriptDomains: ["https://script.example"],
      colorScheme: "dark",
      documentBinding: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      documentDigest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      ipcNonce: TRUSTED_IPC_NONCE,
    });
    const preparedHtml = result.current?.html;
    expect(preparedHtml).toBeDefined();
    expect(result.current?.sandbox.url.href).toBe(
      "http://127.0.0.1:4243/mcp-app-sandbox/proxy/OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO#document=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    );
    expect(result.current?.sandbox.url.search).toBe("");
    expect(result.current?.html).toContain(
      '<meta name="color-scheme" content="dark">',
    );
    expect(result.current?.html).toContain("window.__mcpHostColorScheme");
    expect(JSON.stringify(result.current)).not.toContain("secret");
    expect(onPendingChange.mock.calls).toEqual([[true], [false]]);
  });

  it("removes an app-selected color-scheme meta before binding the guest HTML", async () => {
    mockedCreateMcpAppSandbox.mockResolvedValue({
      proxyUrl:
        "http://127.0.0.1:4243/mcp-app-sandbox/proxy/MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM#document=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    });
    const renderableDocument = {
      ...document("ui://example/meta"),
      html: '<!doctype html><html><head><meta name="color-scheme" content="light dark"><title>App</title></head><body></body></html>',
    };

    const { result } = renderHook(() =>
      useMcpAppSandbox({
        renderableDocument,
        colorScheme: "light",
        onPendingChange,
        onError,
      }),
    );

    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.html.match(/name="color-scheme"/g)).toHaveLength(1);
    expect(result.current?.html).toContain(
      '<meta name="color-scheme" content="light">',
    );
  });

  it.each([
    "https://attacker.example/mcp-app-sandbox/proxy/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA#document=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    "http://127.0.0.1:4243/mcp-app-sandbox/proxy/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "http://127.0.0.1/mcp-app-sandbox/proxy/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA#document=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    "http://127.0.0.1:4243/mcp-app-sandbox/proxy/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA#document=invalid",
  ])("rejects an invalid URL returned across the trusted command boundary: %s", async (proxyUrl) => {
    mockedCreateMcpAppSandbox.mockResolvedValue({ proxyUrl });

    const { result } = renderHook(() =>
      useMcpAppSandbox({
        renderableDocument: document("ui://example/untrusted-url"),
        colorScheme: "light",
        onPendingChange,
        onError,
      }),
    );

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(result.current).toBeNull();
    expect(onPendingChange.mock.calls).toEqual([[true], [false]]);
  });

  it("keeps sandbox identity stable across theme and equivalent document objects", async () => {
    mockedCreateMcpAppSandbox.mockResolvedValue({
      proxyUrl:
        "http://127.0.0.1:4243/mcp-app-sandbox/proxy/TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT#document=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    });
    const initialDocument = document("ui://example/app", {
      connectDomains: ["https://api.example"],
    });
    const { result, rerender } = renderHook(
      ({ renderableDocument, colorScheme }) =>
        useMcpAppSandbox({
          renderableDocument,
          colorScheme,
          onPendingChange,
          onError,
        }),
      {
        initialProps: {
          renderableDocument: initialDocument,
          colorScheme: "light" as "light" | "dark",
        },
      },
    );

    await waitFor(() => expect(result.current).not.toBeNull());
    const initialPreparedDocument = result.current;
    rerender({
      renderableDocument: document("ui://example/app", {
        connectDomains: ["https://api.example"],
      }),
      colorScheme: "dark",
    });

    expect(result.current).toBe(initialPreparedDocument);
    expect(mockedCreateMcpAppSandbox).toHaveBeenCalledTimes(1);
    expect(mockedCreateMcpAppSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ colorScheme: "light" }),
    );
  });

  it("remints a capability when HTML changes at the same resource URI", async () => {
    mockedCreateMcpAppSandbox
      .mockResolvedValueOnce({
        proxyUrl:
          "http://127.0.0.1:4243/mcp-app-sandbox/proxy/FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF#document=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      })
      .mockResolvedValueOnce({
        proxyUrl:
          "http://127.0.0.1:4243/mcp-app-sandbox/proxy/SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS#document=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      });
    const firstDocument = document("ui://example/app");
    const { result, rerender } = renderHook(
      ({ renderableDocument }) =>
        useMcpAppSandbox({
          renderableDocument,
          colorScheme: "light",
          onPendingChange,
          onError,
        }),
      { initialProps: { renderableDocument: firstDocument } },
    );

    await waitFor(() => expect(result.current).not.toBeNull());
    rerender({
      renderableDocument: {
        ...firstDocument,
        html: "<html>replacement</html>",
      },
    });
    expect(result.current).toBeNull();
    await waitFor(() =>
      expect(result.current?.sandbox.url.pathname).toContain(
        "SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
      ),
    );
    expect(mockedCreateMcpAppSandbox).toHaveBeenCalledTimes(2);
    expect(
      mockedCreateMcpAppSandbox.mock.calls[0]?.[0].documentDigest,
    ).not.toBe(mockedCreateMcpAppSandbox.mock.calls[1]?.[0].documentDigest);
  });

  it("hides a stale sandbox while a different document capability is pending", async () => {
    const first = deferred<{ proxyUrl: string }>();
    const second = deferred<{ proxyUrl: string }>();
    mockedCreateMcpAppSandbox
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result, rerender } = renderHook(
      ({ renderableDocument }) =>
        useMcpAppSandbox({
          renderableDocument,
          colorScheme: "light",
          onPendingChange,
          onError,
        }),
      {
        initialProps: { renderableDocument: document("ui://example/first") },
      },
    );

    await waitFor(() =>
      expect(mockedCreateMcpAppSandbox).toHaveBeenCalledTimes(1),
    );
    await act(async () => {
      first.resolve({
        proxyUrl:
          "http://127.0.0.1:4243/mcp-app-sandbox/proxy/FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF#document=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      });
      await first.promise;
    });
    expect(result.current?.sandbox.url.pathname).toContain(
      "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
    );

    rerender({ renderableDocument: document("ui://example/second") });
    expect(result.current).toBeNull();
    await waitFor(() =>
      expect(mockedCreateMcpAppSandbox).toHaveBeenCalledTimes(2),
    );

    await act(async () => {
      second.resolve({
        proxyUrl:
          "http://127.0.0.1:4243/mcp-app-sandbox/proxy/SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS#document=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      });
      await second.promise;
    });
    expect(result.current?.sandbox.url.pathname).toContain(
      "SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
    );
  });

  it("ignores a cancelled request and clears a removed document", async () => {
    const pending = deferred<{ proxyUrl: string }>();
    mockedCreateMcpAppSandbox.mockReturnValue(pending.promise);
    const { result, rerender } = renderHook(
      ({ renderableDocument }) =>
        useMcpAppSandbox({
          renderableDocument,
          colorScheme: "light",
          onPendingChange,
          onError,
        }),
      {
        initialProps: {
          renderableDocument: document("ui://example/removed") as ReturnType<
            typeof document
          > | null,
        },
      },
    );

    await waitFor(() =>
      expect(mockedCreateMcpAppSandbox).toHaveBeenCalledTimes(1),
    );
    rerender({ renderableDocument: null });
    await act(async () => {
      pending.resolve({
        proxyUrl:
          "http://127.0.0.1:4243/mcp-app-sandbox/proxy/CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC#document=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      });
      await pending.promise;
    });

    expect(result.current).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports only the active request failure", async () => {
    const cancelled = deferred<{ proxyUrl: string }>();
    const active = deferred<{ proxyUrl: string }>();
    mockedCreateMcpAppSandbox
      .mockReturnValueOnce(cancelled.promise)
      .mockReturnValueOnce(active.promise);
    const { rerender } = renderHook(
      ({ renderableDocument }) =>
        useMcpAppSandbox({
          renderableDocument,
          colorScheme: "light",
          onPendingChange,
          onError,
        }),
      {
        initialProps: { renderableDocument: document("ui://example/first") },
      },
    );

    await waitFor(() =>
      expect(mockedCreateMcpAppSandbox).toHaveBeenCalledTimes(1),
    );
    rerender({ renderableDocument: document("ui://example/second") });
    await waitFor(() =>
      expect(mockedCreateMcpAppSandbox).toHaveBeenCalledTimes(2),
    );
    await act(async () => {
      cancelled.reject(new Error("cancelled"));
      await expect(cancelled.promise).rejects.toThrow("cancelled");
    });
    expect(onError).not.toHaveBeenCalled();

    await act(async () => {
      active.reject(new Error("active"));
      await expect(active.promise).rejects.toThrow("active");
    });
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
