import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Event } from "@/shared/telemetry/events";

// The tap's only side effect is the `log_renderer_event` command, so the Tauri
// command layer is the whole observable surface.
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

function messageSent(): Event {
  return {
    name: "berd_chat_message_sent",
    parameters: { session_id: "session-1", is_first_message: true },
  };
}

async function loadDevLog() {
  // Re-import so the memoized window label is resolved fresh per test.
  vi.resetModules();
  return await import("./devLog");
}

/** The minimum Tauri internals `getCurrentWindow()` and `invoke` need. */
function stubTauriWindow(label: string): { label: string } {
  const currentWindow = { label };
  window.__TAURI_INTERNALS__ = { metadata: { currentWindow } };
  return currentWindow;
}

function loggedLines(): string[] {
  return invoke.mock.calls
    .filter(([command]) => command === "log_renderer_event")
    .map(([, args]) => String((args as { message: string }).message));
}

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined);
  // Vitest runs with `import.meta.env.DEV` true; stub it explicitly so each
  // test states the gate it is exercising.
  vi.stubEnv("DEV", true);
});

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
  vi.unstubAllEnvs();
});

describe("dev telemetry event viewer", () => {
  it("forwards a fired event to the app log with its window label and params", async () => {
    stubTauriWindow("main");

    const { devLogEvent } = await loadDevLog();
    devLogEvent(messageSent);

    // One line, at info, over the existing renderer log bridge — the Rust side
    // stamps the timestamp, the level, its own `[renderer]` prefix, and the
    // `[telemetry]` target slot. The params are the record's attributes
    // verbatim; nothing else is stamped on.
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("log_renderer_event", {
      level: "info",
      message:
        'main berd_chat_message_sent {"session_id":"session-1","is_first_message":true}',
      target: "telemetry",
    });
  });

  it("tags the forward with the telemetry log target, with no inline styling", async () => {
    stubTauriWindow("main");

    const { devLogEvent } = await loadDevLog();
    devLogEvent(messageSent);

    // The grey terminal rendering keys off the record's log target in the
    // Rust Stdout formatter. The message itself must carry no ANSI escapes:
    // the same message reaches the `berd.log` file target, which the Stdout-
    // only styling exists to keep clean.
    const [, args] = invoke.mock.calls[0] as [
      string,
      { message: string; target?: string },
    ];
    expect(args.target).toBe("telemetry");
    expect(args.message).not.toContain("\u001b");
  });

  it("labels the fire with the window it came from", async () => {
    // Detached session windows are separate webviews that fire the same
    // events; the label is what tells their lines apart in the one terminal.
    stubTauriWindow("session:abc123");

    const { devLogEvent } = await loadDevLog();
    devLogEvent(messageSent);

    expect(loggedLines()).toEqual([
      expect.stringContaining("session:abc123 berd_chat_message_sent"),
    ]);
  });

  it("resolves the window label once per renderer", async () => {
    const currentWindow = stubTauriWindow("main");

    const { devLogEvent } = await loadDevLog();
    devLogEvent(messageSent);
    currentWindow.label = "changed";
    devLogEvent(messageSent);

    // A window's label is fixed for its lifetime, so the tap reads it once
    // rather than on every event.
    expect(loggedLines()).toEqual([
      expect.stringMatching(/^main /),
      expect.stringMatching(/^main /),
    ]);
  });

  it("writes nothing outside the Vite dev server", async () => {
    // `import.meta.env.DEV` is statically false in every `vite build` output,
    // so the tap is dead code there — it never writes event payloads (which
    // carry session/project/agent ids) into a packaged build's log.
    vi.stubEnv("DEV", false);
    stubTauriWindow("main");

    const { devLogEvent } = await loadDevLog();
    devLogEvent(messageSent);

    expect(invoke).not.toHaveBeenCalled();
  });

  it("performs no native work without Tauri internals", async () => {
    const { devLogEvent } = await loadDevLog();
    devLogEvent(messageSent);

    // Routing through `logRendererEvent` rather than a raw `invoke` is what
    // keeps the public seam in `client.inert.test.ts` honest.
    expect(invoke).not.toHaveBeenCalled();
  });

  it("survives a throwing event thunk", async () => {
    stubTauriWindow("main");

    const { devLogEvent } = await loadDevLog();
    expect(() =>
      devLogEvent(() => {
        throw new Error("event construction failed");
      }),
    ).not.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("survives a rejecting invoke without an unhandled rejection", async () => {
    stubTauriWindow("main");
    invoke.mockRejectedValue(new Error("no such command"));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      const { devLogEvent } = await loadDevLog();
      expect(() => devLogEvent(messageSent)).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off("unhandledRejection", unhandled);
    }

    // The forward is fire-and-forget: a failed log must not surface anywhere
    // the app can see it.
    expect(unhandled).not.toHaveBeenCalled();
  });
});
