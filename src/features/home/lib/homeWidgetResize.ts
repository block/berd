import type { LayoutConstraints } from "@/features/layout/api/layout";
import {
  clampToLayoutConstraints,
  isLayoutConstraints,
  snapPoint,
} from "./snapToGrid";
import {
  clampWidgetSizeForInstance,
  HOME_WIDGET_CATALOG_BY_ID,
  widgetSizeForInstance,
  widgetSizeProfile,
} from "../widgets/catalog";
import type { WidgetInstance, WidgetSize } from "../widgets/types";

export interface ResolvedWidgetResize {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ResizeFromOffsetInput {
  instance: WidgetInstance;
  offset: { x: number; y: number };
  viewportZoom: number;
  bounds?: LayoutConstraints;
}

interface ResizeInput {
  instance: WidgetInstance;
  requestedSize: WidgetSize;
  bounds?: LayoutConstraints;
}

function clampResizePosition(
  instance: WidgetInstance,
  size: WidgetSize,
  bounds?: LayoutConstraints,
): { x: number; y: number } {
  const snapped = snapPoint({ x: instance.x, y: instance.y });
  if (
    !HOME_WIDGET_CATALOG_BY_ID[instance.type] ||
    !isLayoutConstraints(bounds)
  ) {
    return snapped;
  }

  return clampToLayoutConstraints(snapped, size, bounds);
}

function requestedSizeFromOffset({
  instance,
  offset,
  viewportZoom,
}: Omit<ResizeFromOffsetInput, "bounds">): WidgetSize {
  const startSize = widgetSizeForInstance(instance);
  const delta = {
    x: offset.x / viewportZoom,
    y: offset.y / viewportZoom,
  };
  const profile = widgetSizeProfile(instance);

  if (!profile.sizeBounds.lockAspectRatio) {
    return {
      width: startSize.width + delta.x,
      height: startSize.height + delta.y,
    };
  }

  const aspectRatio = profile.defaultSize.height / profile.defaultSize.width;
  const width =
    Math.abs(delta.x) >= Math.abs(delta.y / aspectRatio)
      ? startSize.width + delta.x
      : startSize.width + delta.y / aspectRatio;

  return {
    width,
    height: width * aspectRatio,
  };
}

export function resolveWidgetResize({
  instance,
  requestedSize,
  bounds,
}: ResizeInput): ResolvedWidgetResize {
  const size = clampWidgetSizeForInstance(instance, requestedSize);
  const position = clampResizePosition(instance, size, bounds);

  return {
    ...position,
    ...size,
  };
}

export function resolveWidgetResizeFromOffset({
  instance,
  offset,
  viewportZoom,
  bounds,
}: ResizeFromOffsetInput): ResolvedWidgetResize {
  return resolveWidgetResize({
    instance,
    requestedSize: requestedSizeFromOffset({ instance, offset, viewportZoom }),
    bounds,
  });
}
