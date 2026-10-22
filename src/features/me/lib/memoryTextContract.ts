/**
 * Review-safe text contract for memory proposal and document admission.
 *
 * Memory review is a security boundary: the text a person sees in Settings
 * must be the same Unicode text that is scanned for credentials and persisted.
 * We normalize to NFC and LF line endings, trim proposal fields, and reject
 * Unicode format/default-ignorable and control characters that can make
 * displayed text differ from stored bytes or hide tokens from scanners.
 *
 * Emoji ZWJ sequences are rejected deliberately. They are useful for composing
 * visible emoji glyphs, but ZWJ is also a zero-width format character that can
 * split credentials or make reviewed text differ from persisted text. Memory is
 * prose, so rejecting composed emoji is safer than special-casing renderers.
 */

const UNSAFE_DEFAULT_IGNORABLE_OR_FORMAT =
  /[\p{Default_Ignorable_Code_Point}\p{Cf}]/u;

export class UnsafeMemoryTextError extends Error {
  constructor() {
    super("Memory text can't include hidden Unicode control characters.");
    this.name = "UnsafeMemoryTextError";
  }
}

function normalizeMemoryString(value: string): string {
  return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

function assertReviewSafeText(value: string): void {
  for (const character of value) {
    if (UNSAFE_DEFAULT_IGNORABLE_OR_FORMAT.test(character)) {
      throw new UnsafeMemoryTextError();
    }
    const codePoint = character.codePointAt(0) ?? 0;
    const allowedWhitespace = character === "\n" || character === "\t";
    if (
      !allowedWhitespace &&
      ((codePoint <= 0x1f && codePoint !== 0x20) ||
        (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      throw new UnsafeMemoryTextError();
    }
  }
}

export function normalizeMemoryProposalText(content: string): string {
  const normalized = normalizeMemoryString(content).trim();
  assertReviewSafeText(normalized);
  return normalized;
}

export function normalizeMemoryProposalTopic(
  topic: string | null | undefined,
): string | null {
  if (topic === null || topic === undefined) return null;
  const normalized = normalizeMemoryString(topic).trim();
  assertReviewSafeText(normalized);
  return normalized || null;
}

export function normalizeMemoryDocumentText(contents: string): string {
  const normalized = normalizeMemoryString(contents);
  assertReviewSafeText(normalized);
  return normalized;
}
