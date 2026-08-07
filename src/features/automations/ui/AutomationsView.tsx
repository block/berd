import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { IconAlertTriangle, IconPlus, IconRefresh } from "@tabler/icons-react";
import { PlayIcon } from "lucide-react";
import { toast } from "sonner";
import { usePinToHomeWidget } from "@/features/home/hooks/usePinToHomeWidget";
import {
  type AutomationTile,
  createAutomationTile,
  deleteAutomationTile,
  refreshAutomationTile,
  updateAutomationTile,
} from "@/features/automations/api/kgooseAutomations";
import {
  AUTOMATION_TILES_QUERY_KEY,
  AUTOMATIONS_REFETCH_INTERVAL_MS,
  automationTileQueryKey,
  fetchAutomationTileDetail,
  fetchAutomationTilesList,
  invalidateAutomationTileQueries,
} from "@/features/automations/api/automationTilesQuery";
import {
  automationTitle,
  buildDuplicateAutomationRequest,
  canDuplicateAutomation,
} from "@/features/automations/lib/automationFormatting";
import { AutomationBuilderView } from "@/features/automations/ui/AutomationBuilderView";
import type { AutomationBuilderLeaveAction } from "@/features/automations/ui/AutomationBuilderView";
import { AutomationDetailPage } from "@/features/automations/ui/AutomationDetailPage";
import { AutomationHistoryFeed } from "@/features/automations/ui/AutomationHistoryFeed";
import { AutomationsOverview } from "@/features/automations/ui/AutomationsOverview";
import { EmptyState } from "@/features/automations/ui/RunOutput";
import { Badge } from "@/shared/ui/badge";
import { PageHeaderButton } from "@/shared/ui/page-header-button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { PageShell } from "@/shared/ui/page-shell";
import { useSetTopBarActions } from "@/app/contexts/TopBarActionsContext";
import type {
  AppNavigationUpdateOptions,
  AutomationNavigationRoute,
} from "@/app/types/appNavigation";

// Backend occasionally returns a transient 409-ish message during the optimistic
// mutation → refetch window. It's not user-actionable, so we suppress it from
// the detail-page error pill. Local validation errors still surface normally.
const isTransientRefreshError = (msg: string | null | undefined): boolean =>
  !!msg && /being refreshed|try again later/i.test(msg);

const isActiveAutomationRunStatus = (
  status: string | number | undefined,
): boolean => {
  const normalized = String(status ?? "").toLowerCase();
  return normalized.includes("running") || normalized.includes("pending");
};

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return fallback;
}

type AutomationSurfaceMode = "overview" | "history";

interface AutomationsWorkbenchProps {
  route?: AutomationNavigationRoute;
  onRouteChange?: (
    route: AutomationNavigationRoute,
    options?: AppNavigationUpdateOptions,
  ) => void;
  onBreadcrumbLabelChange?: (label: string | null) => void;
  onBuilderLeaveActionChange?: (
    action: AutomationBuilderLeaveAction | null,
  ) => void;
}

export function AutomationsWorkbench({
  route,
  onRouteChange,
  onBreadcrumbLabelChange,
  onBuilderLeaveActionChange,
}: AutomationsWorkbenchProps = {}) {
  const { t } = useTranslation(["automations", "common"]);
  const queryClient = useQueryClient();
  const isRouteControlled = route !== undefined;
  const [internalRoute, setInternalRoute] = useState<AutomationNavigationRoute>(
    { surface: "overview" },
  );
  const currentRoute = route ?? internalRoute;
  const surfaceMode: AutomationSurfaceMode =
    currentRoute.surface === "history" ? "history" : "overview";
  const detailAutomationId =
    currentRoute.surface === "detail" ? currentRoute.automationId : null;
  const detailTab =
    currentRoute.surface === "detail" ? currentRoute.tab : "details";
  const selectedRunKey =
    currentRoute.surface === "detail" ? currentRoute.selectedRunKey : null;
  const selectedGlobalRun =
    currentRoute.surface === "history" ? currentRoute.selectedRun : null;
  const [pendingCreatedAutomationId, setPendingCreatedAutomationId] = useState<
    string | null
  >(null);
  const delayedRefetchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [deleteAutomationId, setDeleteAutomationId] = useState<string | null>(
    null,
  );
  const [mutationError, setMutationError] = useState<string | null>(null);

  const setNavigationRoute = useCallback(
    (
      nextRoute: AutomationNavigationRoute,
      options?: AppNavigationUpdateOptions,
    ) => {
      if (!isRouteControlled) {
        setInternalRoute(nextRoute);
      }
      onRouteChange?.(nextRoute, options);
    },
    [isRouteControlled, onRouteChange],
  );

  const {
    data: automationsData,
    error: automationsError,
    isLoading: isAutomationsLoading,
    refetch: refetchAutomations,
  } = useQuery({
    queryKey: AUTOMATION_TILES_QUERY_KEY,
    queryFn: fetchAutomationTilesList,
    refetchInterval: AUTOMATIONS_REFETCH_INTERVAL_MS,
  });

  const automations = useMemo(() => automationsData ?? [], [automationsData]);

  useEffect(() => {
    if (!automations.length) {
      if (
        !isAutomationsLoading &&
        currentRoute.surface !== "overview" &&
        currentRoute.surface !== "builder"
      ) {
        setNavigationRoute({ surface: "overview" }, { replace: true });
      }
      return;
    }

    if (
      detailAutomationId &&
      !automations.some((tile) => tile.id === detailAutomationId) &&
      detailAutomationId !== pendingCreatedAutomationId
    ) {
      setNavigationRoute({ surface: "overview" }, { replace: true });
    }

    if (
      pendingCreatedAutomationId &&
      automations.some((tile) => tile.id === pendingCreatedAutomationId)
    ) {
      setNavigationRoute(
        {
          surface: "detail",
          automationId: pendingCreatedAutomationId,
          tab: "details",
          selectedRunKey: null,
        },
        { replace: true },
      );
      setPendingCreatedAutomationId(null);
    }
  }, [
    automations,
    isAutomationsLoading,
    currentRoute.surface,
    detailAutomationId,
    pendingCreatedAutomationId,
    setNavigationRoute,
  ]);

  const detailAutomation = automations.find(
    (tile) => tile.id === detailAutomationId,
  );
  const deleteAutomation =
    automations.find((tile) => tile.id === deleteAutomationId) ??
    (detailAutomationId === deleteAutomationId ? detailAutomation : undefined);

  const {
    data: detailData,
    error: detailError,
    isLoading: isDetailLoading,
    refetch: refetchDetail,
  } = useQuery({
    queryKey: automationTileQueryKey(detailAutomationId),
    queryFn: () => fetchAutomationTileDetail(detailAutomationId ?? ""),
    enabled: Boolean(detailAutomationId),
    refetchInterval: AUTOMATIONS_REFETCH_INTERVAL_MS,
  });

  const detailTile = detailData?.tileInfo ?? detailAutomation;
  const detailTileId = detailTile?.id;
  const deleteAutomationName = deleteAutomation
    ? automationTitle(deleteAutomation, t("fallbacks.untitledAutomation"))
    : t("fallbacks.untitledAutomation");

  useEffect(() => {
    if (currentRoute.surface === "builder") {
      onBreadcrumbLabelChange?.(t("builder.title"));
      return;
    }

    if (currentRoute.surface === "history") {
      onBreadcrumbLabelChange?.(t("tabs.history"));
      return;
    }

    if (detailAutomationId && detailTile) {
      onBreadcrumbLabelChange?.(
        automationTitle(detailTile, t("fallbacks.untitledAutomation")),
      );
      return;
    }

    onBreadcrumbLabelChange?.(null);
  }, [
    currentRoute.surface,
    detailAutomationId,
    detailTile,
    onBreadcrumbLabelChange,
    t,
  ]);

  useEffect(() => {
    return () => onBreadcrumbLabelChange?.(null);
  }, [onBreadcrumbLabelChange]);

  const invalidateAutomationQueries = async () => {
    await invalidateAutomationTileQueries(queryClient);
  };

  const selectCreatedAutomation = (automationId: string) => {
    setPendingCreatedAutomationId(automationId);
    setNavigationRoute({
      surface: "detail",
      automationId,
      tab: "details",
      selectedRunKey: null,
    });
  };

  const scheduleDelayedAutomationsRefetch = () => {
    if (delayedRefetchTimeoutRef.current) {
      clearTimeout(delayedRefetchTimeoutRef.current);
    }
    // kgoose list propagation can lag tile creation, so refetch once more
    // after the immediate refresh.
    delayedRefetchTimeoutRef.current = setTimeout(() => {
      void refetchAutomations();
      delayedRefetchTimeoutRef.current = null;
    }, 1_500);
  };

  const openDetail = (automationId: string) => {
    setMutationError(null);
    setDeleteAutomationId(null);
    setNavigationRoute({
      surface: "detail",
      automationId,
      tab: "details",
      selectedRunKey: null,
    });
  };

  const openRunDetail = (automationId: string, runKey: string) => {
    setMutationError(null);
    setDeleteAutomationId(null);
    setNavigationRoute({
      surface: "detail",
      automationId,
      tab: "history",
      selectedRunKey: runKey,
    });
  };

  const updateMutation = useMutation({
    mutationFn: updateAutomationTile,
    onSuccess: async (response) => {
      if (response.success === false) {
        setMutationError(response.errorMsg ?? t("edit.saveError"));
        return;
      }
      setMutationError(null);
      await invalidateAutomationQueries();
    },
    onError: (error) => {
      setMutationError(errorMessage(error, t("edit.saveError")));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteAutomationTile,
    onSuccess: async (response) => {
      if (response.success === false) {
        setMutationError(response.errorMsg ?? t("delete.error"));
        return;
      }
      setMutationError(null);
      setDeleteAutomationId(null);
      setNavigationRoute({ surface: "overview" }, { replace: true });
      await invalidateAutomationQueries();
    },
    onError: (error) => {
      setMutationError(errorMessage(error, t("delete.error")));
    },
  });

  const refreshMutation = useMutation({
    mutationFn: refreshAutomationTile,
    onSuccess: async (response, automationId) => {
      if (response.success === false) {
        toast.error(t("run.error"), {
          description: response.errorMsg ?? t("run.errorDescription"),
        });
        return;
      }

      toast.success(t("run.started"), {
        description:
          detailTile && detailTile.id === automationId
            ? automationTitle(detailTile, t("fallbacks.untitledAutomation"))
            : undefined,
      });
      await invalidateAutomationQueries();
      window.setTimeout(() => {
        void refetchAutomations();
        void refetchDetail();
      }, 250);
    },
    onError: (error) => {
      toast.error(t("run.error"), {
        description: errorMessage(error, t("run.errorDescription")),
      });
    },
  });

  const duplicateMutation = useMutation({
    mutationFn: (tile: AutomationTile) => {
      const request = buildDuplicateAutomationRequest(
        tile,
        t("duplicate.copySuffix"),
      );
      if (!request) {
        throw new Error(t("duplicate.unsupportedType"));
      }
      return createAutomationTile(request);
    },
    onMutate: () => {
      setMutationError(null);
    },
    onSuccess: async (response) => {
      if (response.success === false) {
        setMutationError(response.errorMsg ?? t("duplicate.error"));
        return;
      }
      const automationId = response.tileId ?? response.automationId;
      if (automationId) {
        selectCreatedAutomation(automationId);
      }
      await invalidateAutomationQueries();
      if (automationId) {
        scheduleDelayedAutomationsRefetch();
      }
    },
    onError: (error) => {
      setMutationError(errorMessage(error, t("duplicate.error")));
    },
  });

  useEffect(() => {
    return () => {
      if (delayedRefetchTimeoutRef.current) {
        clearTimeout(delayedRefetchTimeoutRef.current);
      }
    };
  }, []);

  const openBuilder = useCallback(() => {
    setNavigationRoute({ surface: "builder" });
    setMutationError(null);
    setDeleteAutomationId(null);
  }, [setNavigationRoute]);

  const { mutate: duplicateMutate } = duplicateMutation;
  const { mutate: refreshMutate } = refreshMutation;
  const isUpdating = updateMutation.isPending;
  const isRefreshing = refreshMutation.isPending;
  const isDuplicating = duplicateMutation.isPending;
  const isDeleting = deleteMutation.isPending;
  const setTopBarActions = useSetTopBarActions();
  const {
    isPinned: isPinnedToHome,
    isPinning: isPinningToHome,
    pinToHome,
    unpinFromHome,
  } = usePinToHomeWidget({ kind: "automation", id: detailTile?.id });
  const pinLabel = isPinnedToHome
    ? t("common:actions.unpinFromHome")
    : isPinningToHome
      ? t("common:actions.pinningToHome")
      : t("common:actions.pinToHome");

  useEffect(() => {
    if (currentRoute.surface === "builder") {
      setTopBarActions(null);
      return;
    }

    if (detailAutomationId && detailTile) {
      const isRunActive = isActiveAutomationRunStatus(
        detailTile.latestRunStatus,
      );

      setTopBarActions(
        <>
          <PageHeaderButton
            type="button"
            onClick={() => {
              if (!detailTile.id) return;
              refreshMutate(detailTile.id);
            }}
            disabled={!detailTile.id || isRefreshing || isRunActive}
            aria-label={t("actions.runNow")}
            tooltip={t("actions.runNow")}
            leftIcon={<PlayIcon aria-hidden="true" />}
          >
            {isRefreshing || isRunActive
              ? t("actions.running")
              : t("actions.runNow")}
          </PageHeaderButton>
          <PageHeaderButton
            type="button"
            onClick={() => {
              void refetchAutomations();
              void refetchDetail();
            }}
            aria-label={t("actions.refresh")}
            tooltip={t("actions.refresh")}
            leftIcon={<IconRefresh aria-hidden="true" />}
          >
            {t("actions.refreshShort")}
          </PageHeaderButton>
        </>,
      );
      return () => setTopBarActions(null);
    }

    setTopBarActions(
      <>
        <PageHeaderButton
          type="button"
          onClick={() => refetchAutomations()}
          aria-label={t("actions.refresh")}
          tooltip={t("actions.refresh")}
          leftIcon={<IconRefresh aria-hidden="true" />}
        >
          {t("actions.refreshShort")}
        </PageHeaderButton>
        <PageHeaderButton
          type="button"
          onClick={openBuilder}
          aria-label={t("actions.add")}
          tooltip={t("actions.add")}
          leftIcon={<IconPlus aria-hidden="true" />}
        >
          {t("actions.add")}
        </PageHeaderButton>
      </>,
    );
    return () => setTopBarActions(null);
  }, [
    currentRoute.surface,
    detailAutomationId,
    detailTile,
    isRefreshing,
    openBuilder,
    refetchAutomations,
    refetchDetail,
    refreshMutate,
    setTopBarActions,
    t,
  ]);

  if (currentRoute.surface === "builder") {
    return (
      <AutomationBuilderView
        automationId={currentRoute.automationId}
        onAutomationCreated={(automationId) => {
          if (automationId) {
            selectCreatedAutomation(automationId);
          }
          void refetchAutomations().then(() => {
            if (!automationId) return;
            scheduleDelayedAutomationsRefetch();
          });
        }}
        onAutomationUpdated={(automationId) => {
          if (automationId) {
            selectCreatedAutomation(automationId);
          }
          void refetchAutomations().then(() => {
            void refetchDetail();
          });
        }}
        onLeaveActionChange={onBuilderLeaveActionChange}
      />
    );
  }

  return (
    <>
      <PageShell contentClassName="gap-6" contentWidth="default">
        {detailAutomationId ? (
          isDetailLoading && !detailTile ? (
            <div className="space-y-4">
              <div className="h-7 w-64 rounded-md bg-muted" />
              <div className="h-40 rounded-md bg-muted" />
            </div>
          ) : detailTile ? (
            <>
              {detailError ? (
                <div className="mb-4">
                  <Badge variant="destructive">
                    <IconAlertTriangle aria-hidden="true" />
                    {t("details.stale")}
                  </Badge>
                </div>
              ) : null}
              <AutomationDetailPage
                tile={detailTile}
                activeTab={detailTab}
                selectedRunKey={selectedRunKey}
                mutationError={
                  isTransientRefreshError(mutationError) ? null : mutationError
                }
                isSaving={updateMutation.isPending}
                actions={{
                  pinLabel,
                  isPinned: isPinnedToHome,
                  isPinning: isPinningToHome,
                  onTogglePin: () =>
                    isPinnedToHome ? unpinFromHome() : void pinToHome(),
                  onEditWithChat: () => {
                    if (!detailTile.id) return;
                    setNavigationRoute({
                      surface: "builder",
                      automationId: detailTile.id,
                    });
                  },
                  onDuplicate: () => duplicateMutate(detailTile),
                  onDelete: () => {
                    if (!detailTileId) return;
                    setMutationError(null);
                    setDeleteAutomationId(detailTileId);
                  },
                  canEditWithChat: Boolean(detailTile.id),
                  canDuplicate:
                    !isUpdating &&
                    !isDuplicating &&
                    canDuplicateAutomation(detailTile),
                  isDuplicating,
                  isDeleting,
                }}
                onActiveTabChange={(tab) => {
                  if (!detailAutomationId) return;
                  setNavigationRoute({
                    surface: "detail",
                    automationId: detailAutomationId,
                    tab,
                    selectedRunKey,
                  });
                }}
                onSelectRun={(runKey) => {
                  if (!detailAutomationId) return;
                  setNavigationRoute({
                    surface: "detail",
                    automationId: detailAutomationId,
                    tab: detailTab,
                    selectedRunKey: runKey,
                  });
                }}
                onSave={(request) => updateMutation.mutate(request)}
              />
            </>
          ) : (
            <EmptyState
              title={t("details.selectTitle")}
              body={t("details.selectBody")}
            />
          )
        ) : (
          <Tabs
            value={surfaceMode}
            onValueChange={(value) => {
              const nextMode = value as AutomationSurfaceMode;
              setNavigationRoute(
                nextMode === "history"
                  ? { surface: "history", selectedRun: null }
                  : { surface: "overview" },
              );
            }}
          >
            <TabsList variant="weight">
              <TabsTrigger value="overview" variant="weight">
                {t("tabs.overview")}
              </TabsTrigger>
              <TabsTrigger value="history" variant="weight">
                {t("tabs.history")}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="mt-6">
              {isAutomationsLoading ? (
                <div className="space-y-3">
                  <div className="h-[86px] rounded-md bg-card" />
                  <div className="h-[86px] rounded-md bg-card" />
                  <div className="h-[86px] rounded-md bg-card" />
                </div>
              ) : automationsError ? (
                <EmptyState
                  title={t("list.loadErrorTitle")}
                  body={errorMessage(
                    automationsError,
                    t("list.loadErrorTitle"),
                  )}
                />
              ) : automations.length ? (
                <AutomationsOverview
                  automations={automations}
                  onOpenDetail={openDetail}
                />
              ) : (
                <EmptyState
                  title={t("list.emptyTitle")}
                  body={t("list.emptyBody")}
                />
              )}
            </TabsContent>

            <TabsContent value="history" className="mt-6">
              {automations.length ? (
                <AutomationHistoryFeed
                  automations={automations}
                  selectedRun={selectedGlobalRun}
                  onSelectRun={(selectedRun) =>
                    setNavigationRoute({
                      surface: "history",
                      selectedRun,
                    })
                  }
                  onOpenAutomation={({ automationId, runKey }) =>
                    openRunDetail(automationId, runKey)
                  }
                />
              ) : (
                <EmptyState
                  title={t("history.emptyTitle")}
                  body={t("history.emptyBody")}
                />
              )}
            </TabsContent>
          </Tabs>
        )}
      </PageShell>

      <ConfirmDialog
        open={Boolean(deleteAutomationId)}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteAutomationId(null);
          }
        }}
        title={t("delete.title")}
        description={t("delete.description", {
          name: deleteAutomationName,
        })}
        cancelLabel={t("actions.cancel")}
        confirmLabel={t("actions.delete")}
        loadingLabel={t("actions.deleting")}
        isLoading={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteAutomationId) {
            deleteMutation.mutate(deleteAutomationId);
          }
        }}
      />
    </>
  );
}

export function AutomationsView() {
  return <AutomationsWorkbench />;
}
