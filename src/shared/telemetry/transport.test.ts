import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const originalFetch = globalThis.fetch;
const TRANSPORT_BRIDGE_INSTALLED_KEY =
  "__berdTelemetryTransportBridgeInstalled";
const STAGING_BATCH_URL =
  "https://api.squareupstaging.com/1.0/unifiedevents/batch";
const PRODUCTION_BATCH_URL = "https://api.squareup.com/1.0/unifiedevents/batch";

type GlobalWithTelemetryTransport = typeof globalThis & {
  [TRANSPORT_BRIDGE_INSTALLED_KEY]?: boolean;
};

async function loadTransport() {
  vi.resetModules();
  return await import("./transport");
}

beforeEach(() => {
  invoke.mockReset();
  delete (globalThis as GlobalWithTelemetryTransport)[
    TRANSPORT_BRIDGE_INSTALLED_KEY
  ];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as GlobalWithTelemetryTransport)[
    TRANSPORT_BRIDGE_INSTALLED_KEY
  ];
  vi.clearAllMocks();
});

describe("telemetry transport bridge", () => {
  it("routes staging PAE batch posts through the native command", async () => {
    const browserFetch = vi.fn();
    globalThis.fetch = browserFetch as typeof fetch;
    invoke.mockResolvedValue({
      status: 202,
      statusText: "Accepted",
      body: '{"errors":[]}',
    });

    const { installTelemetryTransportBridge } = await loadTransport();
    installTelemetryTransportBridge();

    const response = await fetch(STAGING_BATCH_URL, {
      method: "post",
      body: '{"ue_messages":[]}',
    });

    expect(browserFetch).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("send_telemetry_batch", {
      url: STAGING_BATCH_URL,
      body: '{"ue_messages":[]}',
    });
    expect(response.ok).toBe(true);
    expect(response.status).toBe(202);
    expect(response.statusText).toBe("Accepted");
    await expect(response.json()).resolves.toEqual({ errors: [] });
  });

  it("routes production PAE batch posts through the native command", async () => {
    globalThis.fetch = vi.fn() as typeof fetch;
    invoke.mockResolvedValue({
      status: 200,
      statusText: "OK",
      body: '{"errors":[]}',
    });

    const { installTelemetryTransportBridge } = await loadTransport();
    installTelemetryTransportBridge();

    await fetch(PRODUCTION_BATCH_URL, {
      method: "POST",
      body: '{"ue_messages":[]}',
    });

    expect(invoke).toHaveBeenCalledWith("send_telemetry_batch", {
      url: PRODUCTION_BATCH_URL,
      body: '{"ue_messages":[]}',
    });
  });

  it("delegates non-telemetry requests to browser fetch", async () => {
    const browserFetch = vi.fn(async () => new Response("browser"));
    globalThis.fetch = browserFetch as typeof fetch;

    const { installTelemetryTransportBridge } = await loadTransport();
    installTelemetryTransportBridge();

    const response = await fetch("https://example.com/data", {
      method: "POST",
      body: "payload",
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(browserFetch).toHaveBeenCalledWith("https://example.com/data", {
      method: "POST",
      body: "payload",
    });
    await expect(response.text()).resolves.toBe("browser");
  });

  it("delegates non-post requests to the telemetry URL", async () => {
    const browserFetch = vi.fn(async () => new Response("browser"));
    globalThis.fetch = browserFetch as typeof fetch;

    const { installTelemetryTransportBridge } = await loadTransport();
    installTelemetryTransportBridge();

    await fetch(STAGING_BATCH_URL);

    expect(invoke).not.toHaveBeenCalled();
    expect(browserFetch).toHaveBeenCalledWith(STAGING_BATCH_URL, undefined);
  });
});
