import { writeDiagnosticEvent } from "@/shared/api/diagnostics";

const MAX_TEXT_LENGTH = 4096;
const SECRET_VALUE_PATTERN =
  /\b(authorization|refresh_token|access_token|secret_key|api_key|apikey|password|secret|token)\b\s*[:=]\s*(['"]?)[^,\s;&'"]+/gi;

interface RendererDiagnosticsContext {
  windowKind: "main" | "session" | "voice-buddy";
}

let installed = false;
let context: RendererDiagnosticsContext = { windowKind: "main" };

export function installRendererDiagnostics(
  nextContext: RendererDiagnosticsContext,
) {
  context = nextContext;
  if (installed || typeof window === "undefined") {
    return () => {};
  }

  installed = true;
  window.addEventListener("error", handleWindowError);
  window.addEventListener("unhandledrejection", handleUnhandledRejection);
  return () => {
    window.removeEventListener("error", handleWindowError);
    window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    installed = false;
  };
}

export function reportRendererError(
  event: string,
  error: unknown,
  extraFields: Record<
    string,
    string | number | boolean | null | undefined
  > = {},
) {
  const normalized = normalizeError(error);
  void writeDiagnosticEvent({
    level: "error",
    category: "renderer",
    event,
    fields: {
      windowKind: context.windowKind,
      ...normalized,
      ...sanitizeFields(extraFields),
    },
  }).catch((writeError) => {
    console.warn("Failed to write renderer diagnostic event:", writeError);
  });
}

function handleWindowError(event: ErrorEvent) {
  reportRendererError("window_error", event.error ?? event.message, {
    filename: event.filename,
    lineNumber: event.lineno,
    columnNumber: event.colno,
  });
}

function handleUnhandledRejection(event: PromiseRejectionEvent) {
  reportRendererError("unhandled_rejection", event.reason);
}

function normalizeError(
  error: unknown,
): Record<string, string | number | boolean | null> {
  if (error instanceof Error) {
    return {
      errorName: sanitizeText(error.name),
      message: sanitizeText(error.message),
      stack: sanitizeText(error.stack ?? ""),
    };
  }

  if (typeof error === "string") {
    return {
      errorName: "Error",
      message: sanitizeText(error),
      stack: "",
    };
  }

  return {
    errorName: "NonError",
    message: sanitizeText(Object.prototype.toString.call(error)),
    stack: "",
  };
}

function sanitizeFields(
  fields: Record<string, string | number | boolean | null | undefined>,
) {
  return Object.fromEntries(
    Object.entries(fields)
      .filter(
        (entry): entry is [string, string | number | boolean | null] =>
          entry[1] !== undefined,
      )
      .map(([key, value]) => [
        key,
        typeof value === "string" ? sanitizeText(value) : value,
      ]),
  );
}

function sanitizeText(value: string): string {
  return truncate(value.replace(SECRET_VALUE_PATTERN, "$1=[redacted]"));
}

function truncate(value: string): string {
  if (value.length <= MAX_TEXT_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_TEXT_LENGTH)}...`;
}
