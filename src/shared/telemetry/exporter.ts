/**
 * Native OTLP log-record exporter for Berd telemetry.
 *
 * Replaces the former `@squareup/cdp` dispatch + `globalThis.fetch` monkeypatch.
 * Serializes OTel `ReadableLogRecord`s to OTLP/HTTP JSON and POSTs them through
 * the native `export_otel_logs` Tauri command, so OTLP delivery dodges WebView
 * CORS without intercepting `fetch`. The `BatchLogRecordProcessor` that wraps
 * this exporter owns batching only (see `./client`): a FAILED export drops the
 * batch — the processor never re-queues it. The one retry in the pipeline is
 * native: `export_otel_logs` retries the same body exactly once after
 * re-bootstrapping its upload token on a 401. That drop-on-failure semantic is
 * why `./client` caps batch size and attribute-value length: a body over the
 * gateway's limit comes back 413 and is lost outright, so a full batch is sized
 * to stay under it (`MAX_LOG_EXPORT_BATCH_SIZE`).
 */

import { invoke } from "@tauri-apps/api/core";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type {
  LogRecordExporter,
  ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import { JsonLogsSerializer } from "@opentelemetry/otlp-transformer";

// Injected by vite.config.ts from VITE_OTLP_LOGS_ENDPOINT: the full telemetry
// gateway `https://<host>/v1/logs` URL. Production builds get the production
// gateway (otel.berd.xyz), staging builds the staging gateway
// (otel.test.blockstaging.build); development gets an obviously-fake DUMMY
// host, so the prod/staging gate (see `./client`) plus that placeholder keep
// the path inert in dev and external clones. The native side derives the
// anonymous `/v1/bootstrap` URL from this same endpoint, so no bootstrap URL
// is plumbed here. The fallback below is only reachable where the vite define
// is absent (vitest).
const OTLP_LOGS_ENDPOINT =
  import.meta.env.VITE_OTLP_LOGS_ENDPOINT ??
  "https://otlp.invalid.goose-internal.example/v1/logs";

interface NativeOtelLogsExportResponse {
  status: number;
  statusText: string;
  body: string;
}

/**
 * An OTel `LogRecordExporter` that serializes records to OTLP/HTTP JSON and
 * hands them to the native `export_otel_logs` command. Non-2xx responses and
 * transport failures resolve to `FAILED`, which the processor treats as a
 * dropped batch — there is no renderer-side retry. Auth happens natively:
 * `export_otel_logs` bootstraps and caches a short-lived upload token keyed on
 * the anonymous installation id, and on a 401 re-bootstraps and retries the
 * same body exactly once.
 */
export class TauriOtlpLogExporter implements LogRecordExporter {
  constructor(private readonly endpoint: string = OTLP_LOGS_ENDPOINT) {}

  export(
    logs: ReadableLogRecord[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    let body: string;
    try {
      const serialized = JsonLogsSerializer.serializeRequest(logs);
      if (!serialized) {
        resultCallback({ code: ExportResultCode.SUCCESS });
        return;
      }
      body = new TextDecoder().decode(serialized);
    } catch (error) {
      resultCallback({ code: ExportResultCode.FAILED, error: error as Error });
      return;
    }

    void invoke<NativeOtelLogsExportResponse>("export_otel_logs", {
      endpoint: this.endpoint,
      body,
    })
      .then((response) => {
        if (response.status >= 200 && response.status < 300) {
          resultCallback({ code: ExportResultCode.SUCCESS });
          return;
        }
        resultCallback({
          code: ExportResultCode.FAILED,
          error: new Error(
            `OTLP logs export failed: ${response.status} ${response.statusText}`,
          ),
        });
      })
      .catch((error) =>
        resultCallback({
          code: ExportResultCode.FAILED,
          error: error as Error,
        }),
      );
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

/** Constructs the telemetry exporter using the build-injected OTLP endpoint. */
export function createTelemetryLogExporter(): TauriOtlpLogExporter {
  return new TauriOtlpLogExporter();
}
