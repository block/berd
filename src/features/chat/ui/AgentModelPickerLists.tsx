import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  IconDots,
  IconSearch,
  IconStar,
  IconStarFilled,
  IconX,
} from "@tabler/icons-react";
import { motion, useReducedMotion } from "motion/react";
import { useStarredModels } from "../hooks/useStarredModels";
import { modelStarKey } from "../lib/starredModels";
import { SearchBar } from "@/shared/ui/SearchBar";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/cn";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Separator } from "@/shared/ui/separator";
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

function compareModelsAlphabetically(left: ModelOption, right: ModelOption) {
  const byName = getModelDisplayName(left).localeCompare(
    getModelDisplayName(right),
    undefined,
    { sensitivity: "base" },
  );
  if (byName !== 0) {
    return byName;
  }

  const byId = left.id.localeCompare(right.id);
  if (byId !== 0) {
    return byId;
  }

  return (left.providerId ?? "").localeCompare(right.providerId ?? "");
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
    const leftSelected = modelMatchesSelection(
      left,
      currentModelId,
      currentModelProviderId,
    );
    const rightSelected = modelMatchesSelection(
      right,
      currentModelId,
      currentModelProviderId,
    );
    if (leftSelected !== rightSelected) {
      return leftSelected ? -1 : 1;
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

export interface FavoriteModelOption {
  agentId: string;
  model: ModelOption;
}

interface ModelListProps {
  models: ModelOption[];
  favoriteModels?: FavoriteModelOption[];
  /**
   * The authoritative catalog the rows were built from, without any
   * synthesized rows for the current selection. Starred state is only
   * honored for models present here, so favorited models a provider no
   * longer serves stop rendering as starred. Omit to treat every row as
   * existing.
   */
  catalogModels?: ModelOption[];
  currentModelId: string | null;
  currentModelProviderId: string | null;
  selectedAgentId: string;
  onModelSelect: (model: ModelOption, agentId: string) => void;
  /**
   * Reports whether the list has left the recommended view for the full model
   * list (search or "View more"), so the picker can hide affordances that
   * would interrupt browsing.
   */
  onBrowseChange?: (browsing: boolean) => void;
  t: (key: string, options?: Record<string, string>) => string;
}

export interface RecommendedModelListHandle {
  closeSearch: () => boolean;
}

type StarAnimation = {
  phase: "out" | "moving" | "in";
  targetStarred: boolean;
};

const STAR_SPIN_TRANSITION = {
  duration: 0.24,
  ease: "easeInOut" as const,
  times: [0, 0.18, 0.82, 1],
  opacity: {
    duration: 0.24,
    ease: "easeIn" as const,
    times: [0, 0.18, 0.82, 1],
  },
};

export const RecommendedModelList = forwardRef<
  RecommendedModelListHandle,
  ModelListProps
>(function RecommendedModelList(
  {
    models,
    favoriteModels,
    catalogModels,
    currentModelId,
    currentModelProviderId,
    selectedAgentId,
    onModelSelect,
    onBrowseChange,
    t,
  },
  ref,
) {
  const { toggleStar, starredKeys } = useStarredModels();
  const prefersReducedMotion = useReducedMotion();
  const modelAgentIds = useMemo(
    () =>
      new Map(
        (favoriteModels ?? []).map(({ agentId, model }) => [model, agentId]),
      ),
    [favoriteModels],
  );
  const getModelScopeId = useCallback(
    (model: ModelOption) =>
      model.providerId ?? modelAgentIds.get(model) ?? selectedAgentId,
    [modelAgentIds, selectedAgentId],
  );
  // Rows include a synthesized entry for the current selection when the
  // catalog no longer serves it. Honoring starred state only for catalog
  // models keeps a favorited model a provider dropped from rendering as
  // starred; the stored entry survives so the star returns if the model does.
  const existingModelKeys = useMemo(() => {
    if (!catalogModels) {
      return null;
    }
    return new Set(
      catalogModels.map((model) =>
        modelStarKey(getModelScopeId(model), model.id),
      ),
    );
  }, [catalogModels, getModelScopeId]);
  const favoriteModelKeys = useMemo(
    () =>
      favoriteModels
        ? new Set(
            favoriteModels.map(({ agentId, model }) =>
              modelStarKey(model.providerId ?? agentId, model.id),
            ),
          )
        : existingModelKeys,
    [existingModelKeys, favoriteModels],
  );
  const [starAnimation, setStarAnimation] = useState<{
    modelKey: string;
    scopeId: string;
    modelId: string;
    hasSelectedAgentDestination: boolean;
    state: StarAnimation;
  } | null>(null);
  const liveStarredKeys = useMemo(() => {
    if (!favoriteModelKeys) {
      return starredKeys;
    }
    const live = new Set<string>();
    for (const key of starredKeys) {
      if (favoriteModelKeys.has(key)) {
        live.add(key);
      }
    }
    return live;
  }, [favoriteModelKeys, starredKeys]);
  const starredModels = useMemo(() => {
    const candidates =
      favoriteModels ??
      models.map((model) => ({ agentId: selectedAgentId, model }));
    return candidates.filter(({ agentId, model }) => {
      const modelKey = modelStarKey(model.providerId ?? agentId, model.id);
      return (
        liveStarredKeys.has(modelKey) ||
        (starAnimation?.modelKey === modelKey &&
          !starAnimation.hasSelectedAgentDestination &&
          starAnimation.state.phase === "moving" &&
          !starAnimation.state.targetStarred)
      );
    });
  }, [favoriteModels, liveStarredKeys, models, selectedAgentId, starAnimation]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [hoveredModelKey, setHoveredModelKey] = useState<string | null>(null);
  const [focusedModelKey, setFocusedModelKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const pointerPositionRef = useRef<{ x: number; y: number } | null>(null);
  const rowElementsRef = useRef(new Map<string, HTMLElement>());
  const reconcileRowHover = useCallback(() => {
    const pointer = pointerPositionRef.current;
    if (!pointer) {
      setHoveredModelKey(null);
      return;
    }
    const hoveredEntry = Array.from(rowElementsRef.current).find(([, row]) => {
      const bounds = row.getBoundingClientRect();
      return (
        pointer.x >= bounds.left &&
        pointer.x <= bounds.right &&
        pointer.y >= bounds.top &&
        pointer.y <= bounds.bottom
      );
    });
    setHoveredModelKey(hoveredEntry?.[0] ?? null);
  }, []);
  useEffect(() => {
    if (!starAnimation || prefersReducedMotion) {
      return;
    }
    if (starAnimation.state.phase === "out") {
      const timer = window.setTimeout(() => {
        const changed = toggleStar(
          starAnimation.scopeId,
          starAnimation.modelId,
        );
        setStarAnimation(
          changed
            ? {
                ...starAnimation,
                state: { ...starAnimation.state, phase: "moving" },
              }
            : null,
        );
      }, 240);
      return () => window.clearTimeout(timer);
    }
    if (starAnimation.state.phase === "moving") {
      const timer = window.setTimeout(() => {
        if (starAnimation.state.targetStarred) {
          setStarAnimation({
            ...starAnimation,
            state: { ...starAnimation.state, phase: "in" },
          });
        } else {
          reconcileRowHover();
          setStarAnimation(null);
        }
      }, 240);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => {
      reconcileRowHover();
      setStarAnimation(null);
    }, 240);
    return () => window.clearTimeout(timer);
  }, [prefersReducedMotion, reconcileRowHover, starAnimation, toggleStar]);
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
    setHoveredModelKey(null);
    setFocusedModelKey(null);
    resetScroll();
  }, [resetScroll]);
  const recencyMap = useModelRecency();
  const recommended = useMemo(() => {
    const starred = starredModels.map(({ model }) => model);
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
          ) &&
          !liveStarredKeys.has(
            modelStarKey(getModelScopeId(entry.model), entry.model.id),
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
          !recent.some((r) => r.id === m.id && r.providerId === m.providerId) &&
          !liveStarredKeys.has(modelStarKey(getModelScopeId(m), m.id)),
      );
    const shortlist = [...recent, ...rec];
    if (
      currentModelId &&
      starred.length + shortlist.length > 0 &&
      !starred.some((m) =>
        modelMatchesSelection(m, currentModelId, currentModelProviderId),
      ) &&
      !shortlist.some((m) =>
        modelMatchesSelection(m, currentModelId, currentModelProviderId),
      )
    ) {
      const current = models.find((model) =>
        modelMatchesSelection(model, currentModelId, currentModelProviderId),
      );
      if (current) {
        return [...starred, current, ...shortlist];
      }
    }
    const unstarredFallback = models.filter(
      (model) =>
        !liveStarredKeys.has(modelStarKey(getModelScopeId(model), model.id)),
    );
    return [
      ...starred,
      ...(shortlist.length > 0 ? shortlist : unstarredFallback),
    ];
  }, [
    models,
    currentModelId,
    currentModelProviderId,
    recencyMap,
    selectedAgentId,
    liveStarredKeys,
    starredModels,
    getModelScopeId,
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
    const favoriteRows = starredModels.map(({ model }) => model);
    const regularRows = models.filter(
      (model) =>
        !liveStarredKeys.has(modelStarKey(getModelScopeId(model), model.id)),
    );
    const browsableModels = [...favoriteRows, ...regularRows];
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return browsableModels;
    }
    return browsableModels.filter(
      (model) =>
        model.name.toLowerCase().includes(normalizedQuery) ||
        model.id.toLowerCase().includes(normalizedQuery) ||
        model.displayName?.toLowerCase().includes(normalizedQuery) ||
        model.providerName?.toLowerCase().includes(normalizedQuery) ||
        model.providerId?.toLowerCase().includes(normalizedQuery),
    );
  }, [
    liveStarredKeys,
    models,
    query,
    recommended,
    searchOpen,
    showAll,
    starredModels,
    getModelScopeId,
  ]);

  const grouped = useMemo(() => {
    const starred: ModelOption[] = [];
    const unstarred: ModelOption[] = [];
    for (const model of visibleModels) {
      const scopeId = getModelScopeId(model);
      const modelKey = modelStarKey(scopeId, model.id);
      const retainedForeignFavorite =
        starAnimation?.modelKey === modelKey &&
        !starAnimation.hasSelectedAgentDestination &&
        starAnimation.state.phase === "moving" &&
        !starAnimation.state.targetStarred;
      (liveStarredKeys.has(modelKey) || retainedForeignFavorite
        ? starred
        : unstarred
      ).push(model);
    }
    return {
      starred: [...starred].sort(compareModelsAlphabetically),
      unstarred: sortModels(unstarred, currentModelId, currentModelProviderId, {
        map: recencyMap,
        agentId: selectedAgentId,
      }),
    };
  }, [
    visibleModels,
    currentModelId,
    currentModelProviderId,
    recencyMap,
    selectedAgentId,
    liveStarredKeys,
    getModelScopeId,
    starAnimation,
  ]);
  const sorted = [...grouped.starred, ...grouped.unstarred];
  const layoutItems: Array<
    { type: "model"; model: ModelOption } | { type: "favorites-divider" }
  > = [
    ...grouped.starred.map((model) => ({ type: "model" as const, model })),
    ...(grouped.starred.length > 0 && grouped.unstarred.length > 0
      ? ([{ type: "favorites-divider" }] as const)
      : []),
    ...grouped.unstarred.map((model) => ({ type: "model" as const, model })),
  ];
  const layoutTransition = prefersReducedMotion
    ? { duration: 0 }
    : { type: "spring" as const, duration: 0.24, bounce: 0 };
  const recommendedKeys = new Set(
    recommended.map((model) => modelStarKey(getModelScopeId(model), model.id)),
  );
  const hasMore = models.some(
    (model) =>
      !recommendedKeys.has(modelStarKey(getModelScopeId(model), model.id)),
  );
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
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      onPointerLeave={() => setHoveredModelKey(null)}
    >
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
          <div className="p-1 pr-3">
            {layoutItems.map((item) => {
              if (item.type === "favorites-divider") {
                return (
                  <motion.div
                    key="favorites-divider"
                    layout={prefersReducedMotion ? false : "position"}
                    transition={layoutTransition}
                  >
                    <Separator
                      className="my-1"
                      data-testid="starred-models-divider"
                    />
                  </motion.div>
                );
              }

              const { model } = item;
              const modelAgentId = modelAgentIds.get(model) ?? selectedAgentId;
              const iconProviderId =
                modelAgentId === "goose" && model.providerId
                  ? model.providerId
                  : modelAgentId;
              const providerLabel =
                modelAgentId === "goose"
                  ? getGooseModelProviderLabel(model)
                  : formatProviderLabel(modelAgentId);
              const providerIcon =
                modelAgentId !== "goose" || model.providerId
                  ? getProviderIcon(iconProviderId, "size-3.5")
                  : null;
              const isSelected = modelMatchesSelection(
                model,
                currentModelId,
                currentModelProviderId,
              );
              const scopeId = getModelScopeId(model);
              const modelKey = modelStarKey(scopeId, model.id);
              const starred = liveStarredKeys.has(modelKey);
              const existsInCatalog =
                !favoriteModelKeys || favoriteModelKeys.has(modelKey);
              const activeStarAnimation =
                starAnimation?.modelKey === modelKey
                  ? starAnimation.state
                  : null;
              const idleStarVisible =
                starred ||
                hoveredModelKey === modelKey ||
                focusedModelKey === modelKey;
              const handleStarClick = () => {
                if (starAnimation) {
                  return;
                }
                if (prefersReducedMotion) {
                  toggleStar(scopeId, model.id);
                  return;
                }
                setStarAnimation({
                  modelKey,
                  scopeId,
                  modelId: model.id,
                  hasSelectedAgentDestination:
                    existingModelKeys?.has(modelKey) ?? true,
                  state: { phase: "out", targetStarred: !starred },
                });
              };
              return (
                <motion.div
                  key={modelKey}
                  layout={prefersReducedMotion ? false : "position"}
                  animate={
                    activeStarAnimation?.phase === "moving" &&
                    activeStarAnimation.targetStarred === false &&
                    !starAnimation?.hasSelectedAgentDestination
                      ? { opacity: 0, height: 0 }
                      : { opacity: 1, height: "auto" }
                  }
                  transition={{
                    ...layoutTransition,
                    opacity: { duration: 0.15 },
                    height: { duration: 0.24, ease: "easeInOut" },
                  }}
                >
                  <div
                    ref={(element) => {
                      if (element) {
                        rowElementsRef.current.set(modelKey, element);
                      } else {
                        rowElementsRef.current.delete(modelKey);
                      }
                    }}
                    className={cn(
                      "flex min-w-0 items-center gap-1 rounded-sm",
                      isSelected && "bg-accent",
                    )}
                    data-model-key={modelKey}
                    data-selected={isSelected || undefined}
                    data-starred={starred || undefined}
                    onPointerMove={(event) => {
                      pointerPositionRef.current = {
                        x: event.clientX,
                        y: event.clientY,
                      };
                    }}
                    onPointerEnter={(event) => {
                      pointerPositionRef.current = {
                        x: event.clientX,
                        y: event.clientY,
                      };
                      if (starAnimation?.modelKey !== modelKey) {
                        setHoveredModelKey(modelKey);
                      }
                    }}
                    onPointerLeave={(event) => {
                      pointerPositionRef.current = {
                        x: event.clientX,
                        y: event.clientY,
                      };
                      if (starAnimation?.modelKey !== modelKey) {
                        setHoveredModelKey((current) =>
                          current === modelKey ? null : current,
                        );
                      }
                    }}
                    onFocusCapture={() => setFocusedModelKey(modelKey)}
                    onBlurCapture={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget)) {
                        setFocusedModelKey((current) =>
                          current === modelKey ? null : current,
                        );
                      }
                    }}
                  >
                    <PickerItem
                      onClick={() => {
                        onModelSelect(model, modelAgentId);
                        resetView();
                      }}
                      selected={isSelected}
                      className="w-auto flex-1 justify-between"
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
                    </PickerItem>
                    {existsInCatalog ? (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        selected={starred}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleStarClick();
                        }}
                        data-star-animation-phase={
                          activeStarAnimation?.phase ?? undefined
                        }
                        // Explicit row-local pointer/focus state avoids
                        // sticky WebKit :hover state while keeping the list calm.
                        // The idle (unstarred) star rests on the ghost icon contract's
                        // muted-foreground — ≈5.7:1 light / ≈6.1:1 dark against
                        // the popover, above the 3:1 WCAG non-text bar
                        // (enforced in globals.test.ts) — and favorited rows
                        // soften to foreground/80 via the selected flag.
                        className={cn(
                          "shrink-0",
                          activeStarAnimation?.phase === "moving" &&
                            "pointer-events-none",
                        )}
                        aria-label={t(
                          starred ? "toolbar.unstarModel" : "toolbar.starModel",
                          { model: getModelDisplayName(model) },
                        )}
                        aria-pressed={starred}
                      >
                        <motion.span
                          className="flex"
                          initial={false}
                          animate={
                            activeStarAnimation?.phase === "out"
                              ? {
                                  rotate: starred
                                    ? [0, 0, -180, -180]
                                    : [0, 0, 180, 180],
                                  scale: [1, 0.78, 1.18, 0.9],
                                  opacity: [1, 1, 0.7, 0],
                                }
                              : activeStarAnimation?.phase === "moving"
                                ? {
                                    rotate: -180,
                                    scale: 0.9,
                                    opacity: 0,
                                  }
                                : activeStarAnimation?.phase === "in"
                                  ? {
                                      rotate: [-180, -90, 0, 0],
                                      scale: [0.9, 1.18, 0.96, 1],
                                      opacity: [0, 0, 0.7, 1],
                                    }
                                  : {
                                      rotate: 0,
                                      scale: 1,
                                      opacity: idleStarVisible ? 1 : 0,
                                    }
                          }
                          transition={
                            activeStarAnimation
                              ? STAR_SPIN_TRANSITION
                              : idleStarVisible && !starred
                                ? { opacity: { duration: 0.15 } }
                                : { opacity: { duration: 0 } }
                          }
                        >
                          {starred ? <IconStarFilled /> : <IconStar />}
                        </motion.span>
                      </Button>
                    ) : null}
                  </div>
                </motion.div>
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
