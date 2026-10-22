/**
 * Extract memory-bearing lines so deliberate deletions can create suppression
 * fingerprints. Headings, blanks, and italic notes are file scaffolding, not
 * memories.
 */

/** Lines that carry memory, as opposed to the file's scaffolding. */
export function memoryContentLines(text: string): string[] {
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

/** Exact memory lines removed by an edit, with markdown bullet syntax stripped. */
export function removedMemoryEntries(before: string, after: string): string[] {
  const beforeLines = memoryContentLines(before);
  const afterLines = memoryContentLines(after);
  const beforeSet = new Set(beforeLines);
  // When a save also adds content, a missing line may have been reworded or
  // reorganized rather than rejected. Only pure deletions are safe to turn
  // into durable suppression decisions automatically.
  if (afterLines.some((line) => !beforeSet.has(line))) return [];
  const afterSet = new Set(afterLines);
  return [
    ...new Set(
      beforeLines
        .filter((line) => !afterSet.has(line))
        .map((line) => line.replace(/^[-*]\s+/, "").trim())
        .filter(Boolean),
    ),
  ];
}
