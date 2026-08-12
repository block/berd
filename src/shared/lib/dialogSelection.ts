export function normalizeDialogSelection(
  selected: string | string[] | null,
): string[] {
  if (!selected) {
    return [];
  }

  return Array.isArray(selected) ? selected : [selected];
}
