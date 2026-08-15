import type { LayoutCamera } from "@/features/layout/api/layout";

const STARTER_HOME_LAYOUT_STORAGE_KEY = "goose:home:starter-layout-v18";
const STARTER_HOME_CAMERA_PENDING_STORAGE_KEY =
  "goose:home:starter-camera-pending-v2";

const STARTER_TASK_ROW_HEIGHT = 32;

export type PendingStarterHomeCamera = {
  expectedRevision: number;
  camera: LayoutCamera;
};

export function getStarterTasksHeight(omittedTaskCount: number): number {
  return Math.max(
    156,
    STARTER_HOME_LAYOUT.tasks.height -
      omittedTaskCount * STARTER_TASK_ROW_HEIGHT,
  );
}

export function starterLayoutCenter(rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export const STARTER_HOME_LAYOUT = {
  project: { x: -310, y: -260, width: 680, height: 680 },
  berdy: { x: -500, y: -190 },
  clock: { x: 390, y: -210, width: 192, height: 192 },
  tasks: { x: 350, y: 210, width: 280, height: 248 },
  agents: [
    { x: 10, y: -394, width: 200, height: 220 },
    { x: -310, y: 310, width: 200, height: 220 },
  ],
} as const;

export function hasArrangedStarterHome(): boolean {
  try {
    return localStorage.getItem(STARTER_HOME_LAYOUT_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function getPendingStarterHomeCamera(): PendingStarterHomeCamera | null {
  try {
    const raw = localStorage.getItem(STARTER_HOME_CAMERA_PENDING_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingStarterHomeCamera>;
    if (
      typeof value.expectedRevision !== "number" ||
      !value.camera ||
      typeof value.camera.centerX !== "number" ||
      typeof value.camera.centerY !== "number" ||
      typeof value.camera.zoomBps !== "number"
    ) {
      return null;
    }
    return value as PendingStarterHomeCamera;
  } catch {
    return null;
  }
}

export function clearPendingStarterHomeCamera(): void {
  try {
    localStorage.removeItem(STARTER_HOME_CAMERA_PENDING_STORAGE_KEY);
  } catch {
    // Home remains usable when localStorage is unavailable.
  }
}

export function markStarterHomeArranged(): void {
  try {
    localStorage.setItem(STARTER_HOME_LAYOUT_STORAGE_KEY, "1");
    clearPendingStarterHomeCamera();
  } catch {
    // Home remains usable when localStorage is unavailable.
  }
}

export function markStarterHomeCameraPending(
  pending: PendingStarterHomeCamera,
): void {
  try {
    localStorage.setItem(
      STARTER_HOME_CAMERA_PENDING_STORAGE_KEY,
      JSON.stringify(pending),
    );
  } catch {
    // Home remains usable when localStorage is unavailable.
  }
}

export function resetStarterHomeArrangement(): void {
  try {
    localStorage.removeItem(STARTER_HOME_LAYOUT_STORAGE_KEY);
    clearPendingStarterHomeCamera();
  } catch {
    // Home remains usable when localStorage is unavailable.
  }
}
