import type {
  LayoutCamera,
  LayoutConstraints,
} from "@/features/layout/api/layout";

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface CanvasPoint {
  x: number;
  y: number;
}

const ZOOM_BPS_SCALE = 10_000;
const WHEEL_ZOOM_SENSITIVITY = 0.002;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(min, value), max);
}

export function zoomBpsToViewportZoom(zoomBps: number): number {
  return zoomBps / ZOOM_BPS_SCALE;
}

export function viewportZoomToZoomBps(zoom: number): number {
  return Math.round(zoom * ZOOM_BPS_SCALE);
}

export function snapCanvasPointToDevicePixels(
  point: CanvasPoint,
  devicePixelRatio: number,
): CanvasPoint {
  const ratio =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;

  return {
    x: Math.round(point.x * ratio) / ratio,
    y: Math.round(point.y * ratio) / ratio,
  };
}

export function clampLayoutCamera(
  camera: LayoutCamera,
  constraints: LayoutConstraints,
): LayoutCamera {
  return {
    centerX: clamp(
      camera.centerX,
      constraints.minCenter,
      constraints.maxCenter,
    ),
    centerY: clamp(
      camera.centerY,
      constraints.minCenter,
      constraints.maxCenter,
    ),
    zoomBps: clamp(
      camera.zoomBps,
      constraints.minZoomBps,
      constraints.maxZoomBps,
    ),
  };
}

export function layoutCameraToCanvasViewport(
  camera: LayoutCamera,
  viewportSize: ViewportSize,
  constraints?: LayoutConstraints,
): CanvasViewport {
  const clampedCamera = constraints
    ? clampLayoutCamera(camera, constraints)
    : camera;
  const zoom = zoomBpsToViewportZoom(clampedCamera.zoomBps);

  return {
    x: viewportSize.width / 2 - clampedCamera.centerX * zoom,
    y: viewportSize.height / 2 - clampedCamera.centerY * zoom,
    zoom,
  };
}

export function canvasViewportToLayoutCamera(
  viewport: CanvasViewport,
  viewportSize: ViewportSize,
  constraints?: LayoutConstraints,
): LayoutCamera {
  const camera = {
    centerX: (viewportSize.width / 2 - viewport.x) / viewport.zoom,
    centerY: (viewportSize.height / 2 - viewport.y) / viewport.zoom,
    zoomBps: viewportZoomToZoomBps(viewport.zoom),
  };

  return constraints ? clampLayoutCamera(camera, constraints) : camera;
}

export function screenToWorld(
  point: CanvasPoint,
  viewport: CanvasViewport,
): CanvasPoint {
  return {
    x: (point.x - viewport.x) / viewport.zoom,
    y: (point.y - viewport.y) / viewport.zoom,
  };
}

export function panCanvasViewport(
  startViewport: CanvasViewport,
  startClient: CanvasPoint,
  currentClient: CanvasPoint,
): CanvasViewport {
  return {
    ...startViewport,
    x: startViewport.x + currentClient.x - startClient.x,
    y: startViewport.y + currentClient.y - startClient.y,
  };
}

export function panCanvasViewportByDelta(
  viewport: CanvasViewport,
  delta: CanvasPoint,
): CanvasViewport {
  return {
    ...viewport,
    x: viewport.x - delta.x,
    y: viewport.y - delta.y,
  };
}

export function zoomCanvasViewportByScaleAtPoint(
  viewport: CanvasViewport,
  screenPoint: CanvasPoint,
  zoomFactor: number,
  constraints: LayoutConstraints,
): CanvasViewport {
  const minZoom = zoomBpsToViewportZoom(constraints.minZoomBps);
  const maxZoom = zoomBpsToViewportZoom(constraints.maxZoomBps);
  const nextZoom = clamp(viewport.zoom * zoomFactor, minZoom, maxZoom);
  const worldPoint = screenToWorld(screenPoint, viewport);

  return {
    zoom: nextZoom,
    x: screenPoint.x - worldPoint.x * nextZoom,
    y: screenPoint.y - worldPoint.y * nextZoom,
  };
}

export function zoomCanvasViewportAtPoint(
  viewport: CanvasViewport,
  screenPoint: CanvasPoint,
  deltaY: number,
  constraints: LayoutConstraints,
): CanvasViewport {
  return zoomCanvasViewportByScaleAtPoint(
    viewport,
    screenPoint,
    Math.exp(-deltaY * WHEEL_ZOOM_SENSITIVITY),
    constraints,
  );
}
