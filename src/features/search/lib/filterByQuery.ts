export function filterByQuery<T>(
  items: T[],
  query: string,
  getSearchableFields: (item: T) => Array<string | null | undefined>,
): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  return items.filter((item) =>
    getSearchableFields(item).some((field) =>
      (field ?? "").toLowerCase().includes(normalizedQuery),
    ),
  );
}
