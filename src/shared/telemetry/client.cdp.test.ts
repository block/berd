import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const TRANSPORT_BRIDGE_INSTALLED_KEY =
  "__berdTelemetryTransportBridgeInstalled";

type GlobalWithTelemetryTransport = typeof globalThis & {
  [TRANSPORT_BRIDGE_INSTALLED_KEY]?: boolean;
};

interface NativeTelemetryBatchArgs {
  body: string;
  url: string;
}

interface UnifiedEventingBatch {
  ue_messages: Array<{
    context: {
      app: {
        public_version: string;
        registry_name: string;
      };
      page: {
        path?: string;
        referrer?: string;
        search?: string;
        title?: string;
        url?: string;
      };
    };
    track: {
      event_name: string;
      properties: string;
    };
  }>;
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("@/shared/utils/environment", () => ({
  getEnvironment: () => "production",
  isProduction: () => true,
  isStaging: () => false,
}));

function resetTelemetryTransportBridge() {
  delete (globalThis as GlobalWithTelemetryTransport)[
    TRANSPORT_BRIDGE_INSTALLED_KEY
  ];
}

describe("telemetry CDP payload", () => {
  const originalFetch = globalThis.fetch;
  const originalLocation = window.location.href;
  const originalUserAgent = window.navigator.userAgent;

  beforeEach(() => {
    vi.resetModules();
    invoke.mockReset();
    localStorage.clear();
    resetTelemetryTransportBridge();
    window.history.replaceState(null, "", "/renderer?debug=true");
    Object.defineProperty(document, "referrer", {
      configurable: true,
      value: "http://localhost:1520/previous",
    });
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    window.history.replaceState(null, "", originalLocation);
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value: originalUserAgent,
    });
    delete (document as unknown as Record<string, unknown>).referrer;
    resetTelemetryTransportBridge();
    vi.clearAllMocks();
  });

  it("omits cleared page context fields and sends one app version source in the Unified Eventing batch", async () => {
    const batchBodies: string[] = [];
    invoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "whoami") {
        return Promise.resolve({ email: "someone@squareup.com" });
      }
      if (command === "send_telemetry_batch") {
        batchBodies.push((args as NativeTelemetryBatchArgs).body);
        return Promise.resolve({ status: 200, statusText: "OK", body: "{}" });
      }
      return Promise.reject(new Error(`unexpected command ${command}`));
    });

    const telemetry = await import("./client");
    telemetry.initTelemetry();
    await new Promise((resolve) => setTimeout(resolve, 0));
    telemetry.trackAppLaunched();

    // The batch only lands after the mocked whoami promise settles and the
    // buffer flushes through the real-timer telemetry client; a loaded CI
    // worker can delay those timers well past waitFor's 1s default, so give it
    // headroom (with a matching test timeout below) instead of a flaky timeout.
    await waitFor(() => expect(batchBodies).toHaveLength(1), {
      timeout: 10_000,
    });

    const batch = JSON.parse(batchBodies[0]) as UnifiedEventingBatch;
    const message = batch.ue_messages[0];
    const properties = JSON.parse(message.track.properties) as {
      app_version: string;
    };

    expect(message.track.event_name).toBe(
      "goose_internal_app_lifecycle_launched",
    );
    expect(message.context.app.registry_name).toBe("berd");
    expect(message.context.app.public_version).toBe(properties.app_version);
    expect(message.context.page).toEqual({
      title: telemetry.TELEMETRY_DESKTOP_PAGE_CONTEXT.title,
    });
    expect(message.context.page.path).toBeUndefined();
    expect(message.context.page.referrer).toBeUndefined();
    expect(message.context.page.url).toBeUndefined();
    expect(JSON.stringify(message.context.page)).not.toContain("localhost");
    expect(JSON.stringify(message.context.page)).not.toContain("/renderer");
  }, 15_000);
});
