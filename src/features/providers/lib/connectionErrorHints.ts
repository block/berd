// Translate raw provider connection/model-fetch errors into actionable hints.
//
// After credentials are saved, useCredentials refreshes the provider's live
// model list — which doubles as connection verification (one authenticated
// request validates key + URL + network). The backend relays raw HTTP/network
// errors verbatim; this maps the common failure signatures to guidance a user
// can act on (per the external-model-providers plan: "distinct, actionable
// errors"). Unrecognized errors pass through unchanged.

interface ErrorHint {
  pattern: RegExp;
  hintKey: string;
}

// Ordered: first match wins. Patterns target the stable parts of upstream
// error strings (status codes, errno names), not full sentences.
const ERROR_HINTS: ErrorHint[] = [
  {
    // 401/403 or auth words → the credential itself was rejected.
    pattern:
      /\b401\b|\b403\b|unauthorized|invalid[_ ]api[_ ]key|authentication/i,
    hintKey: "providers.connectionHints.keyRejected",
  },
  {
    // 404 → reachable server, wrong path. Most often a missing /v1 suffix.
    pattern: /\b404\b|not found/i,
    hintKey: "providers.connectionHints.urlLooksWrong",
  },
  {
    // Connection-level failures → nothing answered at all.
    pattern:
      /connection refused|econnrefused|timed?\s?out|etimedout|dns|enotfound|failed to connect|network error/i,
    hintKey: "providers.connectionHints.unreachable",
  },
  {
    // 429 → key works, provider is throttling.
    pattern: /\b429\b|rate limit|too many requests/i,
    hintKey: "providers.connectionHints.rateLimited",
  },
];

/**
 * Returns the i18n key of an actionable hint for a raw provider error
 * message, or null when the error has no recognized signature.
 */
export function connectionHintKeyForError(message: string): string | null {
  const trimmed = message.trim();
  if (!trimmed) {
    return null;
  }
  for (const { pattern, hintKey } of ERROR_HINTS) {
    if (pattern.test(trimmed)) {
      return hintKey;
    }
  }
  return null;
}
