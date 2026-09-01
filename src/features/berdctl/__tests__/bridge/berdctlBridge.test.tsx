import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BerdctlBridge } from "@/features/berdctl/bridge/BerdctlBridge";
import type { BridgeRequest } from "@/features/berdctl/bridge/berdctlPlugin";
import {
  __resetBerdctlLifecycleForTests,
  handleBerdctlRequest,
} from "@/features/berdctl/bridge/lifecycle";
import { CommandError } from "@/features/berdctl/commands/types";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  dispatchCommand: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mocks.listen(...args),
}));

// Keep TOOL_GROUPS real (the set_timeouts push derives from it); only the
// dispatch entry point is replaced.
vi.mock("@/features/berdctl/commands/registry", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/features/berdctl/commands/registry")
    >();
  return {
    ...actual,
    dispatchCommand: (...args: unknown[]) => mocks.dispatchCommand(...args),
  };
});

type RequestHandler = (event: { payload: BridgeRequest }) => void;

let listenHandlers: RequestHandler[] = [];

function emitRequest(request: BridgeRequest): void {
  for (const handler of [...listenHandlers]) {
    handler({ payload: request });
  }
}

function invokeCalls(command: string): unknown[][] {
  return mocks.invoke.mock.calls.filter(([invoked]) => invoked === command);
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

let queryClient: QueryClient;

/** The bridge reads the app's query client (doctor-report cache sharing). */
function renderBridge(ui: ReactNode = <BerdctlBridge />): void {
  render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  // restoreMocks only restores vi.spyOn spies; vi.fn() mocks keep their call
  // history across tests unless cleared explicitly.
  vi.clearAllMocks();
  window.__TAURI_INTERNALS__ = {};
  localStorage.clear();
  listenHandlers = [];
  queryClient = new QueryClient();
  __resetBerdctlLifecycleForTests();

  mocks.listen.mockImplementation((_event: string, handler: RequestHandler) => {
    listenHandlers.push(handler);
    return Promise.resolve(() => {
      listenHandlers = listenHandlers.filter(
        (registered) => registered !== handler,
      );
    });
  });
  mocks.invoke.mockImplementation(async (command: string) => {
    switch (command) {
      case "plugin:berdctl|start":
        return { port: 43210 };
      default:
        return undefined;
    }
  });
  mocks.dispatchCommand.mockResolvedValue(undefined);
});

afterEach(async () => {
  // Unmount now (instead of relying on RTL auto-cleanup ordering) and let the
  // lifecycle reconciler converge on the unmount's desired=false before
  // resetting, so no in-flight stop/start leaks into the next test.
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  __resetBerdctlLifecycleForTests();
  window.__TAURI_INTERNALS__ = undefined;
});

describe("BerdctlBridge lifecycle", () => {
  it("starts the broker and pushes per-action timeouts by default", async () => {
    renderBridge();
    await flushAsync();

    expect(invokeCalls("plugin:berdctl|start")).toHaveLength(1);
    const [, { timeouts }] = invokeCalls("plugin:berdctl|set_timeouts")[0] as [
      string,
      { timeouts: Record<string, number> },
    ];
    expect(timeouts["sessions.create"]).toBe(900_000);
    expect(timeouts["sessions.send"]).toBe(60_000);
    expect(timeouts["sessions.list"]).toBe(30_000);
    expect(timeouts["sessions.archive"]).toBe(150_000);
    expect(timeouts["projects.list"]).toBe(30_000);
  });

  it("starts exactly once under a StrictMode double-mount", async () => {
    renderBridge(
      <StrictMode>
        <BerdctlBridge />
      </StrictMode>,
    );
    await flushAsync();

    expect(invokeCalls("plugin:berdctl|start")).toHaveLength(1);
    expect(invokeCalls("plugin:berdctl|stop")).toHaveLength(0);
  });

  it("goes inert when the plugin is not in this build", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "plugin:berdctl|start") {
        throw new Error(
          "berdctl.start not allowed. Permissions associated with this command: berdctl:default",
        );
      }
      return undefined;
    });
    renderBridge();
    await flushAsync();

    expect(invokeCalls("plugin:berdctl|start")).toHaveLength(1);
    expect(invokeCalls("plugin:berdctl|stop")).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("does not retry-storm after a transient start failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "plugin:berdctl|start") {
        throw new Error("failed to bind 127.0.0.1:0");
      }
      return undefined;
    });
    renderBridge();
    await flushAsync();
    await flushAsync();

    expect(invokeCalls("plugin:berdctl|start")).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("stops a partially started broker when timeout registration fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "plugin:berdctl|start") {
        return { port: 43210 };
      }
      if (command === "plugin:berdctl|set_timeouts") {
        throw new Error("failed to register timeouts");
      }
      return undefined;
    });

    renderBridge();
    await flushAsync();
    await flushAsync();

    expect(invokeCalls("plugin:berdctl|start")).toHaveLength(1);
    expect(invokeCalls("plugin:berdctl|set_timeouts")).toHaveLength(1);
    expect(invokeCalls("plugin:berdctl|stop")).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "[berdctl] failed to start broker",
      expect.any(Error),
    );
  });
});

describe("BerdctlBridge request handling", () => {
  it("dispatches a bridge request and submits an ok result", async () => {
    renderBridge();
    await flushAsync();
    mocks.dispatchCommand.mockResolvedValue({ projects: [] });

    emitRequest({
      id: "req-1",
      command: "projects",
      args: { action: "list" },
      timeoutMs: 30_000,
    });
    await flushAsync();

    expect(mocks.dispatchCommand).toHaveBeenCalledWith(
      "projects",
      { action: "list" },
      { deadlineMs: expect.any(Number) },
    );
    expect(mocks.invoke).toHaveBeenCalledWith("plugin:berdctl|submit_result", {
      result: { id: "req-1", ok: true, data: { projects: [] } },
    });
  });

  it("derives the dispatch deadline from the request's broker-resolved timeoutMs", async () => {
    // A request `timeout_ms` override changes the broker's timeout; the
    // renderer deadline must follow it, not the static per-command value.
    const now = 1_750_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    mocks.dispatchCommand.mockResolvedValue({ ok: true });

    await handleBerdctlRequest({
      id: "req-deadline",
      command: "sessions",
      args: { action: "create", prompt: "hi" },
      timeoutMs: 5_000,
    });

    expect(mocks.dispatchCommand).toHaveBeenCalledWith(
      "sessions",
      { action: "create", prompt: "hi" },
      { deadlineMs: now + 5_000 },
    );
    nowSpy.mockRestore();
  });

  it("maps a CommandError to ok:false with its stable code", async () => {
    renderBridge();
    await flushAsync();
    mocks.dispatchCommand.mockRejectedValue(
      new CommandError("target_session_running", "Cannot archive this session"),
    );

    emitRequest({
      id: "req-2",
      command: "sessions",
      args: { action: "archive", session_id: "other" },
      timeoutMs: 60_000,
    });
    await flushAsync();

    expect(mocks.invoke).toHaveBeenCalledWith("plugin:berdctl|submit_result", {
      result: {
        id: "req-2",
        ok: false,
        error: {
          code: "target_session_running",
          message: "Cannot archive this session",
        },
      },
    });
  });

  it("surfaces the ACP error data payload for non-CommandError failures", async () => {
    renderBridge();
    await flushAsync();
    mocks.dispatchCommand.mockRejectedValue(
      Object.assign(new Error("Internal error"), {
        code: -32603,
        data: "fork failed: session row missing",
      }),
    );

    emitRequest({
      id: "req-acp",
      command: "sessions",
      args: { action: "fork", session_id: "other" },
      timeoutMs: 60_000,
    });
    await flushAsync();

    expect(mocks.invoke).toHaveBeenCalledWith("plugin:berdctl|submit_result", {
      result: {
        id: "req-acp",
        ok: false,
        error: {
          code: "internal_error",
          message: "fork failed: session row missing",
        },
      },
    });
  });

  it("never rejects: a failed submit_result is logged and dropped", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.dispatchCommand.mockResolvedValue({ ok: true });
    mocks.invoke.mockRejectedValue(new Error("ipc closed"));

    await expect(
      handleBerdctlRequest({
        id: "req-3",
        command: "projects",
        args: { action: "list" },
        timeoutMs: 30_000,
      }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
  });
});
