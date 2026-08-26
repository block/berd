import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  LoggerProvider,
  type ReadableLogRecord,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The sizing the batch/attribute ceiling is built from lives with the pipeline
// config in `./client`; importing it here keeps this file measuring the real
// numbers instead of a copy that could drift away from them.
import {
  GATEWAY_BODY_LIMIT_BYTES,
  MAX_LOG_ATTRIBUTE_VALUE_LENGTH,
  MAX_LOG_EXPORT_BATCH_SIZE,
} from "./client";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

// Default endpoint baked into the exporter — the full gateway-shaped
// `https://<host>/v1/logs` URL on the DUMMY placeholder host. Real hosts
// (staging today, production once decided) are injected by vite.config.ts
// via VITE_OTLP_LOGS_ENDPOINT, which is unset in tests so the fallback is
// exercised. This pin is one of the four sites that change together on a
// real-host swap.
const DUMMY_OTLP_ENDPOINT =
  "https://otlp.invalid.goose-internal.example/v1/logs";

interface OtlpAttribute {
  key: string;
  value: { stringValue?: string };
}

interface OtlpLogsBody {
  resourceLogs: Array<{
    resource: { attributes: OtlpAttribute[] };
    scopeLogs: Array<{
      scope: { name: string };
      logRecords: Array<{
        eventName: string;
        timeUnixNano?: string;
        attributes: OtlpAttribute[];
      }>;
    }>;
  }>;
}

function attrValue(
  attributes: OtlpAttribute[],
  key: string,
): string | undefined {
  return attributes.find((attr) => attr.key === key)?.value.stringValue;
}

interface CaptureOptions {
  eventName?: string;
  attributes?: Record<string, string | boolean>;
  count?: number;
  /**
   * Further emissions from the *same* provider. The serializer groups records
   * by their resource, so records that must land in one `resourceLogs` entry
   * have to come from one provider.
   */
  also?: Array<{
    eventName: string;
    attributes: Record<string, string | boolean>;
  }>;
}

/**
 * Emits log records through a provider configured exactly like `./client` —
 * same resource shape, same `logRecordLimits` — and captures the resulting
 * `ReadableLogRecord`s, so the exporter can be exercised against genuine SDK
 * output rather than a hand-built record.
 */
async function captureRecords({
  eventName = "berd_app_lifecycle_launched",
  attributes = {
    app_version: "1.2.3",
    environment: "production",
  },
  count = 1,
  also = [],
}: CaptureOptions = {}): Promise<ReadableLogRecord[]> {
  const captured: ReadableLogRecord[] = [];
  const capture = {
    export(logs: ReadableLogRecord[], cb: (result: ExportResult) => void) {
      captured.push(...logs);
      cb({ code: ExportResultCode.SUCCESS });
    },
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  };
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({
      "service.name": "berd",
      "service.version": "1.2.3",
      "deployment.environment": "production",
      "installation.id": "11111111-2222-4333-8444-555555555555",
      "distribution.channel": "public",
    }),
    logRecordLimits: {
      attributeValueLengthLimit: MAX_LOG_ATTRIBUTE_VALUE_LENGTH,
    },
    processors: [new SimpleLogRecordProcessor({ exporter: capture })],
  });
  const logger = provider.getLogger("berd.telemetry");
  for (let i = 0; i < count; i += 1) {
    logger.emit({
      eventName,
      attributes,
      timestamp: new Date("2026-06-29T00:00:00.000Z"),
    });
  }
  for (const emission of also) {
    // No `timestamp`: the SDK stamps one, which is what the live path does for
    // every event that is not flushed from the pre-identity buffer.
    logger.emit(emission);
  }
  await provider.forceFlush();
  return captured;
}

function exportOnce(
  exporter: {
    export: (logs: ReadableLogRecord[], cb: (r: ExportResult) => void) => void;
  },
  logs: ReadableLogRecord[],
): Promise<ExportResult> {
  return new Promise((resolve) => exporter.export(logs, resolve));
}

async function loadExporter() {
  vi.resetModules();
  return await import("./exporter");
}

beforeEach(() => {
  invoke.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("TauriOtlpLogExporter", () => {
  it("serializes records to OTLP/HTTP JSON and POSTs them via export_otel_logs", async () => {
    invoke.mockResolvedValue({ status: 200, statusText: "OK", body: "{}" });
    const records = await captureRecords();

    const { TauriOtlpLogExporter } = await loadExporter();
    const result = await exportOnce(new TauriOtlpLogExporter(), records);

    expect(result.code).toBe(ExportResultCode.SUCCESS);
    expect(invoke).toHaveBeenCalledTimes(1);
    const [command, args] = invoke.mock.calls[0];
    expect(command).toBe("export_otel_logs");
    expect((args as { endpoint: string }).endpoint).toBe(DUMMY_OTLP_ENDPOINT);

    const body = JSON.parse((args as { body: string }).body) as OtlpLogsBody;
    const resourceLog = body.resourceLogs[0];
    expect(attrValue(resourceLog.resource.attributes, "service.name")).toBe(
      "berd",
    );
    expect(attrValue(resourceLog.resource.attributes, "service.version")).toBe(
      "1.2.3",
    );
    expect(
      attrValue(resourceLog.resource.attributes, "deployment.environment"),
    ).toBe("production");
    expect(
      attrValue(resourceLog.resource.attributes, "distribution.channel"),
    ).toBe("public");

    const scopeLog = resourceLog.scopeLogs[0];
    expect(scopeLog.scope.name).toBe("berd.telemetry");

    const logRecord = scopeLog.logRecords[0];
    expect(logRecord.eventName).toBe("berd_app_lifecycle_launched");
    // Backdated timestamp survives serialization (2026-06-29T00:00:00Z in ns).
    expect(logRecord.timeUnixNano).toBe("1782691200000000000");
    expect(attrValue(logRecord.attributes, "app_version")).toBe("1.2.3");
    expect(attrValue(logRecord.attributes, "environment")).toBe("production");
  });

  it("does not include renderer page context or local URLs in the OTLP body", async () => {
    invoke.mockResolvedValue({ status: 200, statusText: "OK", body: "{}" });
    const records = await captureRecords();

    const { TauriOtlpLogExporter } = await loadExporter();
    await exportOnce(new TauriOtlpLogExporter(), records);

    const { body } = invoke.mock.calls[0][1] as { body: string };
    expect(body).not.toContain("localhost");
    expect(body).not.toContain("/renderer");
    expect(body).not.toContain("referrer");
  });

  it("reports FAILED on a non-2xx response (the processor drops the batch)", async () => {
    invoke.mockResolvedValue({
      status: 503,
      statusText: "Service Unavailable",
      body: "",
    });
    const records = await captureRecords();

    const { TauriOtlpLogExporter } = await loadExporter();
    const result = await exportOnce(new TauriOtlpLogExporter(), records);

    expect(result.code).toBe(ExportResultCode.FAILED);
    expect(result.error?.message).toContain("503");
  });

  it("reports FAILED when the native command throws", async () => {
    invoke.mockRejectedValue(new Error("native transport down"));
    const records = await captureRecords();

    const { TauriOtlpLogExporter } = await loadExporter();
    const result = await exportOnce(new TauriOtlpLogExporter(), records);

    expect(result.code).toBe(ExportResultCode.FAILED);
    expect(result.error?.message).toContain("native transport down");
  });
});

/**
 * The ingestion gateway validates every upload against the `berd-otlp-logs-v2`
 * body schema, which is strict/closed at every level: exactly one
 * `resourceLogs` entry, exactly one `scopeLogs` entry, an exact key set on
 * every object, a closed set of resource attributes, and only string/bool
 * attribute values. Any unmodeled key anywhere is a 400 — nothing is stripped —
 * and a rejected batch is dropped by the processor rather than retried. The
 * schema models no `user_id` and no entity ids (`agent_id`, `project_id`,
 * `item_id`) anywhere — strictness makes a re-introduced one a rejection, not
 * a stray extra column. The chat events' `session_id` is the one per-entity id
 * the schema still models.
 *
 * What the serializer emits is therefore pinned structurally rather than
 * spot-checked: the realistic ways this breaks are silent ones an SDK upgrade
 * or a config edit introduces — default resource attributes (`telemetry.sdk.*`,
 * `process.*`, `host.*`) merged into the resource, a `schemaUrl` or scope
 * `version` appearing, a `severityNumber`/`flags` key on the record, or
 * `timeUnixNano` switching from a JSON string to a number.
 */
describe("berd-otlp-logs-v2 body contract", () => {
  // The gateway's whole accepted resource-attribute set. `service.name` must be
  // the literal `berd` (it, and the scope, were renamed from `goose-internal`
  // before any client shipped), and `distribution.channel` must carry one of
  // the closed values the schema allowlists.
  const RESOURCE_ATTRIBUTE_KEYS = [
    "service.name",
    "service.version",
    "deployment.environment",
    "installation.id",
    "distribution.channel",
  ];
  const LOG_RECORD_KEYS = [
    "timeUnixNano",
    "observedTimeUnixNano",
    "body",
    "eventName",
    "attributes",
    "droppedAttributesCount",
  ];
  const MAX_LOG_RECORDS_PER_REQUEST = 128;

  function expectExactKeys(value: unknown, keys: string[]): void {
    expect(Object.keys(value as object).sort()).toEqual([...keys].sort());
  }

  /** Asserts one `{key, value}` entry uses an encoding the gateway models. */
  function expectAttributeEntry(entry: unknown): void {
    expectExactKeys(entry, ["key", "value"]);
    const { value } = entry as { value: Record<string, unknown> };
    // `intValue`, `doubleValue`, `arrayValue` and the empty `{}` encoding OTLP
    // uses for an absent value are all rejected.
    const encodings = Object.keys(value);
    expect(encodings).toHaveLength(1);
    expect(["stringValue", "boolValue"]).toContain(encodings[0]);
    if (encodings[0] === "stringValue") {
      expect(typeof value.stringValue).toBe("string");
      expect(String(value.stringValue).length).toBeLessThanOrEqual(256);
    } else {
      expect(typeof value.boolValue).toBe("boolean");
    }
  }

  function expectAttributeList(attributes: unknown): void {
    const entries = attributes as Array<{ key: string }>;
    for (const entry of entries) expectAttributeEntry(entry);
    const keys = entries.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
  }

  function expectConformingBody(raw: string): void {
    const body = JSON.parse(raw) as Record<string, unknown>;
    expectExactKeys(body, ["resourceLogs"]);
    const resourceLogs = body.resourceLogs as unknown[];
    expect(resourceLogs).toHaveLength(1);

    // No `schemaUrl` at either level — the SDK omits it only while no schema
    // url is configured on the resource or the logger.
    expectExactKeys(resourceLogs[0], ["resource", "scopeLogs"]);
    const { resource, scopeLogs } = resourceLogs[0] as {
      resource: Record<string, unknown>;
      scopeLogs: unknown[];
    };

    expectExactKeys(resource, ["attributes", "droppedAttributesCount"]);
    expect(resource.droppedAttributesCount).toBe(0);
    const resourceAttributes = resource.attributes as OtlpAttribute[];
    expectAttributeList(resourceAttributes);
    for (const { key } of resourceAttributes) {
      expect(RESOURCE_ATTRIBUTE_KEYS).toContain(key);
    }
    expect(attrValue(resourceAttributes, "service.name")).toBe("berd");
    // Required by the schema, and only from its closed value set.
    expect(["public", "internal"]).toContain(
      attrValue(resourceAttributes, "distribution.channel"),
    );

    expect(scopeLogs).toHaveLength(1);
    expectExactKeys(scopeLogs[0], ["scope", "logRecords"]);
    const { scope, logRecords } = scopeLogs[0] as {
      scope: unknown;
      logRecords: unknown[];
    };
    // A `version` key here is a 400, so the scope is pinned whole rather than
    // by its name alone.
    expect(scope).toEqual({ name: "berd.telemetry" });

    expect(logRecords.length).toBeGreaterThanOrEqual(1);
    expect(logRecords.length).toBeLessThanOrEqual(MAX_LOG_RECORDS_PER_REQUEST);
    for (const record of logRecords) {
      // Exact key set, so `severityNumber`, `severityText`, `traceId`,
      // `spanId` and `flags` are pinned absent by construction.
      expectExactKeys(record, LOG_RECORD_KEYS);
      const log = record as Record<string, unknown>;
      for (const key of ["timeUnixNano", "observedTimeUnixNano"]) {
        // JSON strings, not numbers.
        expect(typeof log[key]).toBe("string");
        expect(log[key]).toMatch(/^\d{1,20}$/);
      }
      expect(log.body).toEqual({});
      expect(typeof log.eventName).toBe("string");
      expect(log.droppedAttributesCount).toBe(0);
      expectAttributeList(log.attributes);
    }
  }

  async function exportedBody(records: ReadableLogRecord[]): Promise<string> {
    invoke.mockResolvedValue({ status: 200, statusText: "OK", body: "{}" });
    const { TauriOtlpLogExporter } = await loadExporter();
    await exportOnce(new TauriOtlpLogExporter(), records);
    return (invoke.mock.calls[0][1] as { body: string }).body;
  }

  it("serializes a mixed batch into a body the gateway's schema accepts", async () => {
    const records = await captureRecords({
      // A backdated buffer flush, string and bool params, and an over-long
      // value that truncation has to bring under the 256-character ceiling.
      eventName: "berd_chat_message_sent",
      attributes: {
        session_id: "11111111-2222-4333-8444-555555555555",
        is_first_message: true,
        has_attachments: false,
        has_persona: true,
        model: "m".repeat(10_000),
      },
      also: [
        {
          eventName: "berd_home_pin_pinned",
          attributes: {
            item_type: "HOME_ITEM_TYPE_CHAT",
          },
        },
        {
          eventName: "berd_project_delete_completed",
          attributes: {
            had_working_dir: true,
            had_artifact: false,
          },
        },
      ],
    });

    expectConformingBody(await exportedBody(records));
  });

  it("keeps a full batch conforming, including its record count", async () => {
    const records = await captureRecords({
      count: MAX_LOG_EXPORT_BATCH_SIZE,
      attributes: {
        app_version: "1.2.3",
        environment: "production",
      },
    });

    // The schema caps a request at 128 records, so the processor's batch size
    // is what keeps a full export inside it.
    expect(MAX_LOG_EXPORT_BATCH_SIZE).toBeLessThanOrEqual(
      MAX_LOG_RECORDS_PER_REQUEST,
    );
    expectConformingBody(await exportedBody(records));
  });

  it("truncates to a length the schema accepts", () => {
    // Truncation is what keeps an over-long value inside the schema's
    // per-value ceiling as well as under the body limit.
    expect(MAX_LOG_ATTRIBUTE_VALUE_LENGTH).toBeLessThanOrEqual(256);
  });
});

/**
 * The gateway 413s an oversized body and the processor drops the rejected
 * batch, so the serialized body has to stay under the limit by construction.
 * These pin the two halves of that: the per-value truncation `./client`
 * configures, and the resulting size of a worst-case full batch.
 */
describe("OTLP body size ceiling", () => {
  const maxed = "x".repeat(MAX_LOG_ATTRIBUTE_VALUE_LENGTH);

  async function exportBody(records: ReadableLogRecord[]): Promise<string> {
    invoke.mockResolvedValue({ status: 200, statusText: "OK", body: "{}" });
    const { TauriOtlpLogExporter } = await loadExporter();
    await exportOnce(new TauriOtlpLogExporter(), records);
    return (invoke.mock.calls[0][1] as { body: string }).body;
  }

  it("truncates an over-long attribute value and leaves real values intact", async () => {
    // A user-typed BYO-key model id is the realistic way one record blows past
    // the limit; without truncation a single paste is worth ~10 KB per record.
    const records = await captureRecords({
      eventName: "berd_chat_message_sent",
      attributes: {
        session_id: "11111111-2222-4333-8444-555555555555",
        model: "m".repeat(10_000),
      },
    });

    const body = JSON.parse(await exportBody(records)) as OtlpLogsBody;
    const attributes =
      body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    expect(attrValue(attributes, "model")).toHaveLength(
      MAX_LOG_ATTRIBUTE_VALUE_LENGTH,
    );
    expect(attrValue(attributes, "session_id")).toBe(
      "11111111-2222-4333-8444-555555555555",
    );
  });

  it("keeps a full batch of maxed-out records under the gateway body limit", async () => {
    // The widest event we send, with every string attribute at the truncation
    // limit: the enforced ceiling, not a realistic payload (a real batch of
    // these records is ~103 KiB).
    const records = await captureRecords({
      count: MAX_LOG_EXPORT_BATCH_SIZE,
      eventName: "berd_chat_session_started",
      attributes: {
        session_id: maxed,
        source_surface: maxed,
        provider: maxed,
        model: maxed,
        has_project: true,
        has_persona: true,
      },
    });
    expect(records).toHaveLength(MAX_LOG_EXPORT_BATCH_SIZE);

    const body = await exportBody(records);
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(
      GATEWAY_BODY_LIMIT_BYTES,
    );
  });
});
