import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { IconCheck, IconDots, IconSearch, IconX } from "@tabler/icons-react";
import { SearchBar } from "@/shared/ui/SearchBar";
import { Button } from "@/shared/ui/button";
import { ScrollArea } from "@/shared/ui/scroll-area";
import {
  formatProviderLabel,
  getProviderIcon,
} from "@/shared/ui/icons/ProviderIcons";
import type { ModelOption } from "../types";
import {
  getModelRecencyRank,
  type ModelRecencyMap,
  useModelRecency,
} from "@/features/chat/lib/modelRecency";
import { PickerItem } from "./AgentModelPickerItem";

/**
 * Long uncurated lists are where search is most needed, so the search
 * affordance also appears when the visible list exceeds this many rows even
 * if no models are hidden behind a recommended shortlist.
 */
const SEARCHABLE_LIST_THRESHOLD = 8;

const RECENT_MODEL_LIMIT = 3;

function getModelDisplayName(model: ModelOption) {
  return model.displayName ?? model.name;
}

function getGooseModelProviderLabel(model: ModelOption) {
  if (model.providerName) {
    return model.providerName;
  }

  if (model.providerId) {
    return formatProviderLabel(model.providerId);
  }

  return null;
}

function compareModelsByProviderOrderAndName(
  left: ModelOption,
  right: ModelOption,
): number {
  const leftProvider = getGooseModelProviderLabel(left) ?? "";
  const rightProvider = getGooseModelProviderLabel(right) ?? "";
  if (leftProvider !== rightProvider) {
    return leftProvider.localeCompare(rightProvider);
  }

  const leftOrder = left.sortOrder ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = right.sortOrder ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }

  return getModelDisplayName(left).localeCompare(getModelDisplayName(right));
}

function modelMatchesSelection(
  model: ModelOption,
  currentModelId: string | null,
  currentModelProviderId: string | null,
) {
  if (model.id !== currentModelId) {
    return false;
  }

  if (currentModelProviderId) {
    return model.providerId === currentModelProviderId;
  }

  // Providerless selections are ambiguous legacy/incomplete state, so fall back
  // to model-ID-only matching until the user selects a concrete provider row.
  return true;
}

function sortModels(
  models: ModelOption[],
  currentModelId: string | null,
  currentModelProviderId: string | null,
  recency: { map: ModelRecencyMap; agentId: string },
) {
  return [...models].sort((left, right) => {
    if (modelMatchesSelection(left, currentModelId, currentModelProviderId)) {
      return -1;
    }
    if (modelMatchesSelection(right, currentModelId, currentModelProviderId)) {
      return 1;
    }

    const leftRank = getModelRecencyRank(recency.map, recency.agentId, left);
    const rightRank = getModelRecencyRank(recency.map, recency.agentId, right);
    if (leftRank !== null && rightRank === null) {
      return -1;
    }
    if (rightRank !== null && leftRank === null) {
      return 1;
    }
    if (leftRank !== null && rightRank !== null && leftRank !== rightRank) {
      return rightRank - leftRank;
    }

    return compareModelsByProviderOrderAndName(left, right);
  });
}

interface ModelListProps {
  models: ModelOption[];
  currentModelId: string | null;
  currentModelProviderId: string | null;
  selectedAgentId: string;
  onModelSelect: (model: ModelOption) => void;
  /**
   * Reports whether the list has left the recommended view for the full model
   * list (search or "View more"), so the picker can hide affordances that
   * would interrupt browsing.
   */
  onBrowseChange?: (browsing: boolean) => void;
  t: (key: string) => string;
}

export interface RecommendedModelListHandle {
  closeSearch: () => boolean;
}

export const RecommendedModelList = forwardRef<
  RecommendedModelListHandle,
  ModelListProps
>(function RecommendedModelList(
  {
    models,
    currentModelId,
    currentModelProviderId,
    selectedAgentId,
    onModelSelect,
    onBrowseChange,
    t,
  },
  ref,
) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const restoreSearchButtonFocusRef = useRef(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const resetScroll = useCallback(() => {
    const viewport = scrollAreaRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (viewport) {
      viewport.scrollTop = 0;
    }
  }, []);
  const resetView = useCallback(() => {
    setQuery("");
    setSearchOpen(false);
    setShowAll(false);
    resetScroll();
  }, [resetScroll]);
  const recencyMap = useModelRecency();
  const recommended = useMemo(() => {
    const recent = models
      .map((m) => ({
        model: m,
        rank: getModelRecencyRank(recencyMap, selectedAgentId, m),
      }))
      .filter(
        (entry): entry is { model: ModelOption; rank: number } =>
          entry.rank !== null &&
          !modelMatchesSelection(
            entry.model,
            currentModelId,
            currentModelProviderId,
          ),
      )
      .sort((left, right) => {
        if (left.rank !== right.rank) {
          return right.rank - left.rank;
        }

        return compareModelsByProviderOrderAndName(left.model, right.model);
      })
      .slice(0, RECENT_MODEL_LIMIT)
      .map((entry) => entry.model);
    const rec = models
      .filter((m) => m.recommended)
      .filter(
        (m) =>
          !recent.some((r) => r.id === m.id && r.providerId === m.providerId),
      );
    const shortlist = [...recent, ...rec];
    if (
      currentModelId &&
      shortlist.length > 0 &&
      !shortlist.some((m) =>
        modelMatchesSelection(m, currentModelId, currentModelProviderId),
      )
    ) {
      const current = models.find((m) =>
        modelMatchesSelection(m, currentModelId, currentModelProviderId),
      );
      if (current) {
        return [current, ...shortlist];
      }
    }
    return shortlist.length > 0 ? shortlist : models;
  }, [
    models,
    currentModelId,
    currentModelProviderId,
    recencyMap,
    selectedAgentId,
  ]);

  useEffect(() => {
    if (searchOpen) {
      inputRef.current?.focus();
    } else if (restoreSearchButtonFocusRef.current) {
      restoreSearchButtonFocusRef.current = false;
      searchButtonRef.current?.focus();
    }
  }, [searchOpen]);

  // One effect covers every path into and out of the full list: open/close
  // search, "View more", and the `resetView` that follows a selection.
  const browsing = searchOpen || showAll;
  useEffect(() => {
    onBrowseChange?.(browsing);
  }, [browsing, onBrowseChange]);
  // Unmounting (agent switch, models cleared) leaves no view to browse.
  useEffect(() => {
    return () => {
      onBrowseChange?.(false);
    };
  }, [onBrowseChange]);

  const visibleModels = useMemo(() => {
    if (!searchOpen && !showAll) {
      return recommended;
    }
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return models;
    }
    return models.filter(
      (model) =>
        model.name.toLowerCase().includes(normalizedQuery) ||
        model.id.toLowerCase().includes(normalizedQuery) ||
        model.displayName?.toLowerCase().includes(normalizedQuery) ||
        model.providerName?.toLowerCase().includes(normalizedQuery) ||
        model.providerId?.toLowerCase().includes(normalizedQuery),
    );
  }, [models, query, recommended, searchOpen, showAll]);

  const sorted = useMemo(
    () =>
      sortModels(visibleModels, currentModelId, currentModelProviderId, {
        map: recencyMap,
        agentId: selectedAgentId,
      }),
    [
      visibleModels,
      currentModelId,
      currentModelProviderId,
      recencyMap,
      selectedAgentId,
    ],
  );

  const hasMore = models.length > recommended.length;
  const showSearchButton =
    hasMore || recommended.length > SEARCHABLE_LIST_THRESHOLD;
  const closeSearch = useCallback(() => {
    resetScroll();
    restoreSearchButtonFocusRef.current = true;
    setQuery("");
    setSearchOpen(false);
  }, [resetScroll]);
  useImperativeHandle(
    ref,
    () => ({
      closeSearch: () => {
        if (!searchOpen) {
          return false;
        }
        closeSearch();
        return true;
      },
    }),
    [closeSearch, searchOpen],
  );
  const openSearch = () => {
    resetScroll();
    setSearchOpen(true);
  };
  const showAllModels = () => {
    resetScroll();
    setShowAll(true);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center px-1">
        {searchOpen ? (
          <div data-model-search-open className="relative mr-2 min-w-0 flex-1">
            <SearchBar
              inputRef={inputRef}
              size="picker"
              value={query}
              onChange={(nextQuery) => {
                resetScroll();
                setQuery(nextQuery);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  event.stopPropagation();
                }
              }}
              placeholder={t("toolbar.searchModels")}
              aria-label={t("toolbar.searchModels")}
              className="min-w-0 origin-right animate-in fade-in zoom-in-95 duration-150 ease-out motion-reduce:animate-none"
            />
            <Button
              variant="ghost"
              size="icon-xxs"
              onClick={closeSearch}
              className="absolute top-1/2 right-1 -translate-y-1/2"
              aria-label={t("search.close")}
              title={t("search.close")}
            >
              <IconX />
            </Button>
          </div>
        ) : (
          <span className="flex flex-1 items-center justify-between text-sm font-semibold">
            <span>{t("toolbar.model")}</span>
            {showSearchButton ? (
              <Button
                ref={searchButtonRef}
                variant="ghost"
                size="icon-xxs"
                onClick={openSearch}
                className="mr-3"
                aria-label={t("toolbar.searchModels")}
                title={t("toolbar.searchModels")}
              >
                <IconSearch />
              </Button>
            ) : null}
          </span>
        )}
      </div>
      {sorted.length > 0 ? (
        <ScrollArea
          ref={scrollAreaRef}
          className="min-h-0 min-w-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block"
        >
          <div className="space-y-0.5 p-1 pr-3">
            {sorted.map((model) => {
              const providerLabel = getGooseModelProviderLabel(model);
              const providerIcon =
                selectedAgentId === "goose" && model.providerId
                  ? getProviderIcon(model.providerId, "size-3.5")
                  : null;
              const isSelected = modelMatchesSelection(
                model,
                currentModelId,
                currentModelProviderId,
              );
              return (
                <PickerItem
                  key={`${model.providerId ?? "model"}:${model.id}`}
                  onClick={() => {
                    onModelSelect(model);
                    resetView();
                  }}
                  selected={isSelected}
                  className="justify-between"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                    {providerIcon ? (
                      <span
                        className="shrink-0 text-muted-foreground"
                        title={providerLabel ?? undefined}
                      >
                        {providerIcon}
                      </span>
                    ) : null}
                    <div className="min-w-0 flex-1 truncate">
                      {getModelDisplayName(model)}
                    </div>
                  </div>
                  {isSelected ? (
                    <IconCheck className="size-4 shrink-0 text-muted-foreground" />
                  ) : null}
                </PickerItem>
              );
            })}
            {hasMore && !searchOpen && !showAll ? (
              <PickerItem
                onClick={showAllModels}
                className="text-muted-foreground/70 hover:text-muted-foreground"
              >
                <IconDots className="size-3.5 shrink-0" />
                <span>{t("toolbar.viewMore")}</span>
              </PickerItem>
            ) : null}
          </div>
        </ScrollArea>
      ) : (
        <div className="px-3 py-4 text-center text-sm text-muted-foreground">
          {t("toolbar.noSearchResults")}
        </div>
      )}
    </div>
  );
});
