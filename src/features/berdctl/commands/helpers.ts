import { formatAcpErrorMessage } from "@/shared/api/acpErrors";

/** Truncate with an ellipsis; shared by previews/summaries/message bodies. */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Bound on any backend error detail berdctl relays onto the wire. */
const ERROR_DETAIL_LIMIT = 2000;

/** Bound `data` before it is stringified so a pathological payload is never
 *  fully serialized; a pre-bound marker preserves the structured-data path. */
function capRawData(data: unknown): unknown {
  if (typeof data === "string") {
    return truncate(data, ERROR_DETAIL_LIMIT);
  }
  if (data === undefined || data === null) {
    return data;
  }
  try {
    const serialized = JSON.stringify(data);
    if (typeof serialized !== "string") return data;
    return serialized.length <= ERROR_DETAIL_LIMIT
      ? data
      : { detail: `${serialized.slice(0, ERROR_DETAIL_LIMIT)}…` };
  } catch {
    return data;
  }
}

/**
 * Format a backend failure for berdctl callers. formatAcpErrorMessage
 * surfaces an ACP error's `data` payload, where goose puts the underlying
 * message (String(error) drops it); the cap keeps a pathological payload
 * from bloating the wire result.
 */
export function berdctlErrorDetail(error: unknown): string {
  if (typeof error === "string") {
    return truncate(error, ERROR_DETAIL_LIMIT);
  }
  if (typeof error === "object" && error !== null && "data" in error) {
    // Spread drops the Error prototype (and `message` is non-enumerable), so
    // re-attach it explicitly or formatAcpErrorMessage falls back to
    // String(error) — "[object Object]" — for the structured-data path.
    const message =
      "message" in error && typeof error.message === "string"
        ? error.message
        : undefined;
    return truncate(
      formatAcpErrorMessage({
        ...error,
        ...(message === undefined ? {} : { message }),
        data: capRawData(error.data),
      }),
      ERROR_DETAIL_LIMIT,
    );
  }
  return truncate(formatAcpErrorMessage(error), ERROR_DETAIL_LIMIT);
}

export const sessionNotFoundMessage = (id: string) =>
  `No session "${id}"; list sessions with \`berdctl session list\`.`;

export const backendArchiveFailedMessage = (
  kind: "session" | "project",
  id: string,
  detail?: string,
) =>
  `The app backend refused to archive "${id}"${detail ? `: ${detail}` : ""}; confirm the id with \`berdctl ${kind} list\` and retry.`;
