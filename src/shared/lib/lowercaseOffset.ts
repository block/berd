/** Map a lowercase-string offset back to the original text. Some characters,
 * such as İ, expand during lowercasing; substring offsets then differ. */
export function originalLowercaseOffset(
  text: string,
  offset: number,
  roundUp = false,
): number {
  let folded = 0;
  let original = 0;
  for (const character of text) {
    const nextFolded = folded + character.toLowerCase().length;
    const nextOriginal = original + character.length;
    if (offset < nextFolded) return roundUp ? nextOriginal : original;
    if (offset === nextFolded) return nextOriginal;
    folded = nextFolded;
    original = nextOriginal;
  }
  return text.length;
}
