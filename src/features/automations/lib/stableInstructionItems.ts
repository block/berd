export function getStableInstructionItems(instructions: string[]) {
  const occurrences = new Map<string, number>();
  return instructions.map((instruction) => {
    const occurrence = occurrences.get(instruction) ?? 0;
    occurrences.set(instruction, occurrence + 1);
    return {
      instruction,
      key:
        occurrence === 0 ? instruction : `${instruction} (${occurrence + 1})`,
    };
  });
}
