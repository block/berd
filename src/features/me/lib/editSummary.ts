/**
 * What a hand-edit changed, in one line.
 *
 * Memory written by an agent already reads well in the history, because the
 * calling code knows the entry and passes it as the commit subject: "Add:
 * Prefers aisle seats". Hand-edits went through with no summary at all, so
 * every one of them said just "Edit" — leaving the history least useful for
 * exactly the changes a person made on purpose, and giving them no way to
 * see that a line they removed is still recoverable in the trail.
 *
 * This compares the file before and after and names the change the way the
 * agent paths do. Content lines only: blank lines, headings, and the italic
 * notes-to-self are structure rather than memory, so a reworded hint
 * shouldn't read as an edit to what agents know.
 */

/** Lines that carry memory, as opposed to the file's scaffolding. */
function contentLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (line.startsWith("#")) return false; // headings
      // Italic notes are guidance for the person, never sent to agents.
      const italic =
        line.startsWith("*") &&
        !line.startsWith("**") &&
        !line.startsWith("* ");
      if (italic) return false;
      return true;
    });
}

/** Trim an entry to something that reads as a commit subject. */
function shorten(line: string, max = 48): string {
  const text = line.replace(/^[-*]\s+/, "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * A one-line summary of a hand-edit, or null when nothing meaningful
 * changed (whitespace, a reworded hint) and the generic "Edit" is honest.
 *
 * Single-line changes name the entry, because that's the case where the
 * history most needs to be specific — a removed line stays in the trail,
 * and the person should be able to see which one. Larger edits report
 * counts, since quoting five lines in a commit subject helps nobody.
 */
export function summarizeEdit(before: string, after: string): string | null {
  const from = contentLines(before);
  const to = contentLines(after);

  const removed = from.filter((line) => !to.includes(line));
  const added = to.filter((line) => !from.includes(line));

  if (!removed.length && !added.length) return null;

  if (added.length === 1 && !removed.length) {
    return `Add: ${shorten(added[0])}`;
  }
  if (removed.length === 1 && !added.length) {
    return `Remove: ${shorten(removed[0])}`;
  }
  if (added.length === 1 && removed.length === 1) {
    return `Change: ${shorten(added[0])}`;
  }

  const parts: string[] = [];
  if (added.length) parts.push(`added ${added.length}`);
  if (removed.length) parts.push(`removed ${removed.length}`);
  return `Edit: ${parts.join(", ")}`;
}
