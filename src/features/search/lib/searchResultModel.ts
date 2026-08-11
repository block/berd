import type { SectionId } from "@/features/settings/ui/settingsSections";
import type { SettingsSearchItem } from "@/features/settings/ui/settingsSearchItems";
import { SETTINGS_SEARCH_ITEMS } from "@/features/settings/ui/settingsSearchItems";

export type SearchCategory =
  | "all"
  | "chat"
  | "extensions"
  | "agents"
  | "skills"
  | "automations"
  | "settings";

export interface SettingsSearchResult {
  id: string;
  sectionId: SectionId;
  title: string;
}

export type TranslateSettingsLabel = (key: string) => string;

export function searchResultId(kind: string, key: string): string {
  return `search-result-${kind}-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

export function buildSettingsSearchResults({
  query,
  enabled,
  translate,
  visibleSections,
  hiddenItemIds = [],
}: {
  query: string;
  enabled: boolean;
  translate: TranslateSettingsLabel;
  visibleSections: readonly {
    id: SectionId;
    labelKey: string;
  }[];
  hiddenItemIds?: readonly string[];
}): SettingsSearchResult[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!enabled || !normalizedQuery) return [];

  const visibleSectionIds = new Set(
    visibleSections.map((section) => section.id),
  );
  const hiddenSearchItemIds = new Set(hiddenItemIds);
  const visibleSearchItems: readonly SettingsSearchItem[] =
    SETTINGS_SEARCH_ITEMS.filter(
      (item) =>
        visibleSectionIds.has(item.sectionId) &&
        !hiddenSearchItemIds.has(item.id),
    );
  const itemResults = visibleSearchItems
    .filter((item) =>
      translate(item.labelKey).toLocaleLowerCase().includes(normalizedQuery),
    )
    .map((item) => ({
      id: item.id,
      sectionId: item.sectionId,
      title: translate(item.labelKey),
    }));
  const sectionResults = visibleSections
    .filter((section) =>
      translate(section.labelKey).toLocaleLowerCase().includes(normalizedQuery),
    )
    .map((section) => ({
      id: `section-${section.id}`,
      sectionId: section.id,
      title: translate(section.labelKey),
    }));

  return [...itemResults, ...sectionResults].filter(
    (result, index, results) =>
      results.findIndex(
        (candidate) =>
          candidate.title === result.title &&
          candidate.sectionId === result.sectionId,
      ) === index,
  );
}

export function buildResultNavigationModel({
  activeCategory,
  columnsByCategory,
}: {
  activeCategory: SearchCategory;
  columnsByCategory: Record<SearchCategory, string[]>;
}) {
  const allColumns = Object.entries(columnsByCategory)
    .filter(([category, column]) => category !== "all" && column.length > 0)
    .map(([, column]) => column);
  const navigableColumns =
    activeCategory === "all"
      ? allColumns
      : [columnsByCategory[activeCategory]].filter(
          (column) => column.length > 0,
        );

  return {
    allColumns,
    allIds: allColumns.flat(),
    navigableColumns,
    navigableIds: navigableColumns.flat(),
  };
}

export function findResultPosition(
  resultColumns: string[][],
  resultId: string | null,
): { columnIndex: number; rowIndex: number } | null {
  if (!resultId) return null;

  for (
    let columnIndex = 0;
    columnIndex < resultColumns.length;
    columnIndex += 1
  ) {
    const rowIndex = resultColumns[columnIndex].indexOf(resultId);
    if (rowIndex >= 0) return { columnIndex, rowIndex };
  }

  return null;
}
