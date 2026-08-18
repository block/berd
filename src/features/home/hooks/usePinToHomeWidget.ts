import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { LayoutConstraints } from "@/features/layout/api/layout";
import {
  recordHomeItemPinIntent,
  recordHomeItemUnpinIntent,
} from "../lib/homePinTelemetry";
import {
  findPinnedHomeWidgetId,
  isPinnedToHome,
  normalizedTargetId,
  PIN_TARGET_CONFIG,
  type PinToHomeTarget,
  type PinToHomeTargetKind,
} from "../lib/homePinTargets";
import { clampToLayoutConstraints, snapPoint } from "../lib/snapToGrid";
import { useHomeWidgetStore } from "../stores/homeWidgetStore";
import {
  HOME_WIDGET_CATALOG_BY_ID,
  widgetSizeForInstance,
} from "../widgets/catalog";
import type { WidgetInstance, WidgetSize } from "../widgets/types";

const PLACEMENT_PADDING = 24;
const PLACEMENT_STEP = 72;
const PLACEMENT_ATTEMPTS = 36;

function rectsOverlap(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    left.x < right.x + right.width + PLACEMENT_PADDING &&
    left.x + left.width + PLACEMENT_PADDING > right.x &&
    left.y < right.y + right.height + PLACEMENT_PADDING &&
    left.y + left.height + PLACEMENT_PADDING > right.y
  );
}

function isOpenPlacement(
  point: { x: number; y: number },
  size: WidgetSize,
  instances: WidgetInstance[],
): boolean {
  const candidate = { ...point, ...size };
  return instances.every((instance) => {
    const instanceSize = widgetSizeForInstance(instance);
    return !rectsOverlap(candidate, {
      x: instance.x,
      y: instance.y,
      width: instanceSize.width,
      height: instanceSize.height,
    });
  });
}

function placedTopLeft(
  center: { x: number; y: number },
  size: WidgetSize,
  constraints: LayoutConstraints | null,
): { x: number; y: number } {
  const snapped = snapPoint({
    x: center.x - size.width / 2,
    y: center.y - size.height / 2,
  });

  return constraints
    ? clampToLayoutConstraints(snapped, size, constraints)
    : snapped;
}

function centerForTopLeft(
  point: { x: number; y: number },
  size: WidgetSize,
): { x: number; y: number } {
  return {
    x: point.x + size.width / 2,
    y: point.y + size.height / 2,
  };
}

function chooseOpenPlacementTopLeft({
  constraints,
  instances,
  size,
  viewportCenter,
}: {
  constraints: LayoutConstraints | null;
  instances: WidgetInstance[];
  size: WidgetSize;
  viewportCenter: { x: number; y: number };
}): { x: number; y: number } {
  const firstPoint = placedTopLeft(viewportCenter, size, constraints);
  if (isOpenPlacement(firstPoint, size, instances)) {
    return firstPoint;
  }

  const startAngle = Math.random() * Math.PI * 2;
  const angleStep = Math.PI * (3 - Math.sqrt(5));
  for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt += 1) {
    const ring = Math.floor(attempt / 8) + 1;
    const radius = ring * PLACEMENT_STEP;
    const angle = startAngle + attempt * angleStep;
    const candidateCenter = {
      x: viewportCenter.x + Math.cos(angle) * radius,
      y: viewportCenter.y + Math.sin(angle) * radius,
    };
    const candidatePoint = placedTopLeft(candidateCenter, size, constraints);

    if (isOpenPlacement(candidatePoint, size, instances)) {
      return candidatePoint;
    }
  }

  return firstPoint;
}

export function choosePinPlacementCenter({
  constraints,
  instances,
  type,
  viewportCenter,
}: {
  constraints: LayoutConstraints | null;
  instances: WidgetInstance[];
  type: string;
  viewportCenter: { x: number; y: number };
}): { x: number; y: number } {
  const defaultSize = HOME_WIDGET_CATALOG_BY_ID[type]?.defaultSize ?? {
    width: 1,
    height: 1,
  };
  const topLeft = chooseOpenPlacementTopLeft({
    constraints,
    instances,
    size: defaultSize,
    viewportCenter,
  });
  return centerForTopLeft(topLeft, defaultSize);
}

export function usePinToHomeWidget(target: PinToHomeTarget) {
  const { t } = useTranslation("home");
  const [isPinning, setIsPinning] = useState(false);
  const instances = useHomeWidgetStore((state) => state.instances);
  const loadStatus = useHomeWidgetStore((state) => state.loadStatus);
  const { id, kind, legacyIds } = target;

  const pinnedWidgetId = useMemo(
    () => findPinnedHomeWidgetId(instances, { id, kind, legacyIds }),
    [id, instances, kind, legacyIds],
  );
  const isPinned = pinnedWidgetId !== null;

  const unpinFromHome = useCallback(() => {
    const targetId = normalizedTargetId(id);
    if (!targetId) {
      return;
    }

    try {
      const state = useHomeWidgetStore.getState();
      if (state.loadStatus !== "ready") {
        toast.error(t("widgets.unpinFromHome.error"));
        return;
      }

      const currentPinnedWidgetId = findPinnedHomeWidgetId(state.instances, {
        id: targetId,
        kind,
        legacyIds,
      });
      if (!currentPinnedWidgetId) {
        return;
      }

      state.removeWidget(currentPinnedWidgetId);
      recordHomeItemUnpinIntent({ kind, itemId: targetId, legacyIds });
      toast.success(t("widgets.unpinFromHome.success"));
    } catch {
      toast.error(t("widgets.unpinFromHome.error"));
    }
  }, [id, kind, legacyIds, t]);

  const pinToHome = useCallback(async () => {
    const targetId = normalizedTargetId(id);
    if (!targetId) {
      return;
    }

    setIsPinning(true);
    try {
      const initialState = useHomeWidgetStore.getState();
      const pinTarget = { id: targetId, kind, legacyIds };
      if (isPinnedToHome(initialState.instances, pinTarget)) {
        return;
      }

      await initialState.initialize();

      const readyState = useHomeWidgetStore.getState();
      if (readyState.loadStatus !== "ready") {
        toast.error(t("widgets.pinToHome.error"));
        return;
      }
      if (isPinnedToHome(readyState.instances, pinTarget)) {
        return;
      }

      const config = PIN_TARGET_CONFIG[kind];
      const camera = readyState.camera ?? {
        centerX: 0,
        centerY: 0,
        zoomBps: 10_000,
      };
      const placementCenter = choosePinPlacementCenter({
        constraints: readyState.constraints,
        instances: readyState.instances,
        type: config.widgetType,
        viewportCenter: { x: camera.centerX, y: camera.centerY },
      });

      readyState.addWidget(
        config.widgetType,
        placementCenter.x,
        placementCenter.y,
        { [config.stateKey]: targetId },
        readyState.constraints ?? undefined,
      );
      recordHomeItemPinIntent({ kind, itemId: targetId, legacyIds });
      toast.success(t("widgets.pinToHome.success"));
    } catch {
      toast.error(t("widgets.pinToHome.error"));
    } finally {
      setIsPinning(false);
    }
  }, [id, kind, legacyIds, t]);

  return {
    isPinned,
    isPinning: isPinning || loadStatus === "loading",
    pinToHome,
    unpinFromHome,
  };
}

function normalizedUniqueIds(ids: string[]): string[] {
  const normalizedIds: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const normalized = normalizedTargetId(id);
    if (normalized && !seen.has(normalized)) {
      normalizedIds.push(normalized);
      seen.add(normalized);
    }
  }
  return normalizedIds;
}

export function usePinBatchToHome() {
  const { t } = useTranslation("home");
  const [isPinningBatch, setIsPinningBatch] = useState(false);

  const pinBatchToHome = useCallback(
    async (kind: PinToHomeTargetKind, ids: string[]) => {
      const normalizedIds = normalizedUniqueIds(ids);
      if (normalizedIds.length === 0) {
        return;
      }

      setIsPinningBatch(true);
      try {
        const initialState = useHomeWidgetStore.getState();
        await initialState.initialize();

        const readyState = useHomeWidgetStore.getState();
        if (readyState.loadStatus !== "ready") {
          toast.error(t("widgets.pinBatchToHome.error"));
          return;
        }

        const config = PIN_TARGET_CONFIG[kind];
        const widgetSize = HOME_WIDGET_CATALOG_BY_ID[config.widgetType]
          ?.defaultSize ?? { width: 1, height: 1 };

        const toPin: string[] = [];
        let skipped = 0;
        for (const id of normalizedIds) {
          if (isPinnedToHome(readyState.instances, { kind, id })) {
            skipped += 1;
          } else {
            toPin.push(id);
          }
        }

        if (toPin.length === 0) {
          toast.success(t("widgets.pinBatchToHome.allPinned"));
          return;
        }

        const cols = Math.ceil(Math.sqrt(toPin.length));
        const cellW = widgetSize.width + PLACEMENT_PADDING;
        const cellH = widgetSize.height + PLACEMENT_PADDING;
        const rows = Math.ceil(toPin.length / cols);
        const bboxSize: WidgetSize = {
          width: cols * cellW - PLACEMENT_PADDING,
          height: rows * cellH - PLACEMENT_PADDING,
        };

        const camera = readyState.camera ?? {
          centerX: 0,
          centerY: 0,
          zoomBps: 10_000,
        };
        const origin = chooseOpenPlacementTopLeft({
          constraints: readyState.constraints,
          instances: readyState.instances,
          size: bboxSize,
          viewportCenter: { x: camera.centerX, y: camera.centerY },
        });

        toPin.forEach((id, idx) => {
          const col = idx % cols;
          const row = Math.floor(idx / cols);
          const centerX = origin.x + col * cellW + widgetSize.width / 2;
          const centerY = origin.y + row * cellH + widgetSize.height / 2;
          readyState.addWidget(
            config.widgetType,
            centerX,
            centerY,
            { [config.stateKey]: id },
            readyState.constraints ?? undefined,
          );
          recordHomeItemPinIntent({ kind, itemId: id });
        });

        if (skipped > 0) {
          toast.success(
            t("widgets.pinBatchToHome.successPartial", {
              count: toPin.length,
              displayCount: toPin.length,
              skipped,
            }),
          );
        } else {
          toast.success(
            t("widgets.pinBatchToHome.success", {
              count: toPin.length,
              displayCount: toPin.length,
            }),
          );
        }
      } catch {
        toast.error(t("widgets.pinBatchToHome.error"));
      } finally {
        setIsPinningBatch(false);
      }
    },
    [t],
  );

  const unpinBatchFromHome = useCallback(
    (kind: PinToHomeTargetKind, ids: string[]) => {
      const normalizedIds = normalizedUniqueIds(ids);
      if (normalizedIds.length === 0) {
        return;
      }

      try {
        if (useHomeWidgetStore.getState().loadStatus !== "ready") {
          toast.error(t("widgets.unpinBatchFromHome.error"));
          return;
        }

        let removed = 0;
        for (const id of normalizedIds) {
          // Re-read the store each iteration: removeWidget replaces instances.
          const state = useHomeWidgetStore.getState();
          const widgetId = findPinnedHomeWidgetId(state.instances, {
            kind,
            id,
          });
          if (widgetId) {
            state.removeWidget(widgetId);
            recordHomeItemUnpinIntent({ kind, itemId: id });
            removed += 1;
          }
        }

        toast.success(
          t("widgets.unpinBatchFromHome.success", {
            count: removed,
            displayCount: removed,
          }),
        );
      } catch {
        toast.error(t("widgets.unpinBatchFromHome.error"));
      }
    },
    [t],
  );

  return { pinBatchToHome, unpinBatchFromHome, isPinningBatch };
}
