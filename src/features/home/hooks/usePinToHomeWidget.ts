import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { LayoutConstraints } from "@/features/layout/api/layout";
import { clampToLayoutConstraints, snapPoint } from "../lib/snapToGrid";
import { useHomeWidgetStore } from "../stores/homeWidgetStore";
import {
  HOME_WIDGET_CATALOG_BY_ID,
  widgetSizeForInstance,
} from "../widgets/catalog";
import type { WidgetInstance, WidgetSize } from "../widgets/types";

const PIN_TARGET_CONFIG = {
  agent: { widgetType: "agentPin", stateKey: "agentId" },
  chat: { widgetType: "chatPin", stateKey: "sessionId" },
  project: { widgetType: "projectArtifactPin", stateKey: "projectId" },
  automation: { widgetType: "automationOutputPin", stateKey: "automationId" },
  skill: { widgetType: "skillPin", stateKey: "skillId" },
} as const;

const PLACEMENT_PADDING = 24;
const PLACEMENT_STEP = 72;
const PLACEMENT_ATTEMPTS = 36;

export type PinToHomeTargetKind = keyof typeof PIN_TARGET_CONFIG;

export interface PinToHomeTarget {
  kind: PinToHomeTargetKind;
  id: string | null | undefined;
}

function normalizedTargetId(id: string | null | undefined): string | null {
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

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
  const firstPoint = placedTopLeft(viewportCenter, defaultSize, constraints);
  if (isOpenPlacement(firstPoint, defaultSize, instances)) {
    return centerForTopLeft(firstPoint, defaultSize);
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
    const candidatePoint = placedTopLeft(
      candidateCenter,
      defaultSize,
      constraints,
    );

    if (isOpenPlacement(candidatePoint, defaultSize, instances)) {
      return centerForTopLeft(candidatePoint, defaultSize);
    }
  }

  return centerForTopLeft(firstPoint, defaultSize);
}

export function isPinnedToHome(
  instances: WidgetInstance[],
  target: PinToHomeTarget,
): boolean {
  const targetId = normalizedTargetId(target.id);
  if (!targetId) {
    return false;
  }

  const config = PIN_TARGET_CONFIG[target.kind];
  return instances.some(
    (instance) =>
      instance.type === config.widgetType &&
      instance.state?.[config.stateKey] === targetId,
  );
}

export function usePinToHomeWidget(target: PinToHomeTarget) {
  const { t } = useTranslation("home");
  const [isPinning, setIsPinning] = useState(false);
  const instances = useHomeWidgetStore((state) => state.instances);
  const loadStatus = useHomeWidgetStore((state) => state.loadStatus);
  const { id, kind } = target;

  const isPinned = useMemo(
    () => isPinnedToHome(instances, { id, kind }),
    [id, instances, kind],
  );

  const pinToHome = useCallback(async () => {
    const targetId = normalizedTargetId(id);
    if (!targetId) {
      return;
    }

    setIsPinning(true);
    try {
      const initialState = useHomeWidgetStore.getState();
      const pinTarget = { id: targetId, kind };
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
      toast.success(t("widgets.pinToHome.success"));
    } catch {
      toast.error(t("widgets.pinToHome.error"));
    } finally {
      setIsPinning(false);
    }
  }, [id, kind, t]);

  return {
    isPinned,
    isPinning: isPinning || loadStatus === "loading",
    pinToHome,
  };
}
