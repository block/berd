function getErrorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error.trim();
  }

  if (error instanceof Error) {
    return error.message.trim();
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message.trim();
  }

  return "";
}

function stringifyData(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

export function formatAcpErrorMessage(
  error: unknown,
  fallback = "Unknown error",
): string {
  const message = getErrorMessage(error);
  if (typeof error === "object" && error !== null && "data" in error) {
    const data = error.data;
    if (typeof data === "string") {
      const detail = data.trim();
      if (detail) {
        return detail;
      }
    } else if (data !== undefined && data !== null) {
      return `${message || String(error)}: ${stringifyData(data)}`;
    }
  }

  return message || fallback;
}
