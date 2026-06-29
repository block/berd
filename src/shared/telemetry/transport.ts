import { invoke } from "@tauri-apps/api/core";

const TELEMETRY_BATCH_URLS = new Set([
  "https://api.squareup.com/1.0/unifiedevents/batch",
  "https://api.squareupstaging.com/1.0/unifiedevents/batch",
]);

const TRANSPORT_BRIDGE_INSTALLED_KEY =
  "__berdTelemetryTransportBridgeInstalled";

interface NativeTelemetryBatchResponse {
  status: number;
  statusText: string;
  body: string;
}

type GlobalWithTelemetryTransport = typeof globalThis & {
  [TRANSPORT_BRIDGE_INSTALLED_KEY]?: boolean;
};

function requestUrl(input: RequestInfo | URL): string | null {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.url;
  }
  return null;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.method.toUpperCase();
  }
  return "GET";
}

async function requestBody(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<string> {
  if (typeof init?.body === "string") return init.body;
  if (init?.body !== undefined && init.body !== null) {
    return await new Response(init.body).text();
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return await input.clone().text();
  }
  return "";
}

/**
 * Routes only the PAE Unified Eventing batch requests through native Tauri
 * networking. Everything else stays on the browser fetch implementation.
 */
export function installTelemetryTransportBridge(): void {
  const bridgeGlobal = globalThis as GlobalWithTelemetryTransport;
  if (bridgeGlobal[TRANSPORT_BRIDGE_INSTALLED_KEY]) return;
  if (typeof globalThis.fetch !== "function") return;

  const browserFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (
      url === null ||
      !TELEMETRY_BATCH_URLS.has(url) ||
      requestMethod(input, init) !== "POST"
    ) {
      return await browserFetch(input, init);
    }

    const body = await requestBody(input, init);
    const response = await invoke<NativeTelemetryBatchResponse>(
      "send_telemetry_batch",
      { url, body },
    );

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
    });
  }) as typeof fetch;
  bridgeGlobal[TRANSPORT_BRIDGE_INSTALLED_KEY] = true;
}
