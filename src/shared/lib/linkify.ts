/**
 * Splits plain text into text and URL segments so callers can render bare
 * http(s) URLs as real links. Kept intentionally conservative: it only matches
 * absolute http/https URLs (matching `isExternalHref`'s notion of "external")
 * and trims trailing punctuation that is almost never part of the URL.
 */

export interface LinkifyTextSegment {
  type: "text";
  value: string;
}

export interface LinkifyLinkSegment {
  type: "link";
  value: string;
  href: string;
}

export type LinkifySegment = LinkifyTextSegment | LinkifyLinkSegment;

// Match absolute http(s) URLs. Stop at whitespace or angle brackets; trailing
// punctuation is trimmed separately so sentence punctuation stays out of links.
// Built per call so the stateful `lastIndex` of a global regex is never shared.
function createUrlRegex(): RegExp {
  return /https?:\/\/[^\s<>]+/gi;
}

// Trailing characters that are usually sentence punctuation rather than part of
// the URL. Closing brackets/quotes are only trimmed when unbalanced.
const TRAILING_PUNCTUATION = new Set([
  ".",
  ",",
  ";",
  ":",
  "!",
  "?",
  '"',
  "'",
  "”",
  "’",
  "»",
]);

const CLOSING_TO_OPENING: Record<string, string> = {
  ")": "(",
  "]": "[",
  "}": "{",
};

function trimTrailingPunctuation(url: string): string {
  let end = url.length;
  while (end > 0) {
    const char = url[end - 1];
    if (TRAILING_PUNCTUATION.has(char)) {
      end -= 1;
      continue;
    }
    const opening = CLOSING_TO_OPENING[char];
    if (opening) {
      const slice = url.slice(0, end);
      const opens = slice.split(opening).length - 1;
      const closes = slice.split(char).length - 1;
      if (closes > opens) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return url.slice(0, end);
}

/**
 * Break `text` into ordered segments of plain text and http(s) links.
 * Returns a single text segment when no URLs are present.
 */
export function linkifyText(text: string): LinkifySegment[] {
  if (!text) {
    return [{ type: "text", value: text }];
  }

  const segments: LinkifySegment[] = [];
  let lastIndex = 0;

  const urlRegex = createUrlRegex();
  let match = urlRegex.exec(text);
  while (match !== null) {
    const rawUrl = match[0];
    const trimmedUrl = trimTrailingPunctuation(rawUrl);
    const start = match.index;

    if (start > lastIndex) {
      segments.push({ type: "text", value: text.slice(lastIndex, start) });
    }

    if (trimmedUrl) {
      segments.push({ type: "link", value: trimmedUrl, href: trimmedUrl });
    }

    // Any punctuation trimmed off the URL is emitted as trailing text so it is
    // not lost from the rendered output.
    const trailing = rawUrl.slice(trimmedUrl.length);
    if (trailing) {
      segments.push({ type: "text", value: trailing });
    }

    lastIndex = start + rawUrl.length;
    match = urlRegex.exec(text);
  }

  if (lastIndex < text.length) {
    segments.push({ type: "text", value: text.slice(lastIndex) });
  }

  if (segments.length === 0) {
    return [{ type: "text", value: text }];
  }

  return segments;
}
