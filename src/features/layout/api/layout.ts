import { invoke } from "@tauri-apps/api/core";

export const HOME_LAYOUT_ID = "home";

export type LayoutItemKind =
  | "session"
  | "project"
  | "persona"
  | "clock"
  | "stickyNote"
  | "checklist"
  | "photo"
  | "automation"
  | "skill"
  | "prompt";

export interface LayoutConstraints {
  minCenter: number;
  maxCenter: number;
  minSize: number;
  maxSize: number;
  minZoomBps: number;
  maxZoomBps: number;
  maxTitleOverrideLength: number;
  maxItems: number;
}

export interface LayoutCamera {
  centerX: number;
  centerY: number;
  zoomBps: number;
}

export interface LayoutItem {
  id: string;
  kind: LayoutItemKind;
  targetId: string;
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  zIndex: number;
  titleOverride: string | null;
  widgetState?: Record<string, unknown> | null;
}

export interface Layout {
  layoutId: string;
  itemRevision: number;
  cameraRevision: number;
  camera: LayoutCamera;
  items: LayoutItem[];
  constraints: LayoutConstraints;
}

export type LayoutMutationResult =
  | { ok: true; layout: Layout }
  | { ok: false; reason: "revisionConflict"; layout: Layout };

export interface SaveLayoutItemsRequest {
  layoutId: string;
  expectedRevision: number;
  replaceKinds: LayoutItemKind[];
  items: LayoutItem[];
}

export interface SaveLayoutCameraRequest {
  layoutId: string;
  expectedRevision: number;
  camera: LayoutCamera;
}

export interface ResetLayoutRequest {
  layoutId: string;
  expectedItemRevision: number;
  expectedCameraRevision: number;
}

export async function getLayout(layoutId: string): Promise<Layout> {
  return invoke("get_layout", { layoutId });
}

export async function saveLayoutItems(
  request: SaveLayoutItemsRequest,
): Promise<LayoutMutationResult> {
  return invoke("save_layout_items", { request });
}

export async function saveLayoutCamera(
  request: SaveLayoutCameraRequest,
): Promise<LayoutMutationResult> {
  return invoke("save_layout_camera", { request });
}

export async function resetLayout(
  request: ResetLayoutRequest,
): Promise<LayoutMutationResult> {
  return invoke("reset_layout", { request });
}
