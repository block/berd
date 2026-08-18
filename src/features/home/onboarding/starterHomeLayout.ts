import type { LayoutCamera } from "@/features/layout/api/layout";

const STARTER_HOME_LAYOUT_STORAGE_KEY = "goose:home:starter-layout-v19";
const PREVIOUS_STARTER_HOME_LAYOUT_STORAGE_KEYS = [
  "goose:home:starter-layout-v14",
  "goose:home:starter-layout-v15",
  "goose:home:starter-layout-v16",
  "goose:home:starter-layout-v18",
] as const;
const STARTER_HOME_LAYOUT_ELIGIBLE_STORAGE_KEY =
  "goose:home:starter-layout-eligible-v1";
const STARTER_HOME_CAMERA_PENDING_STORAGE_KEY =
  "goose:home:starter-camera-pending-v2";

const STARTER_TASK_ROW_HEIGHT = 28;

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
  project: { x: -266, y: -334, width: 748, height: 748 },
  berdy: { x: -368, y: -180 },
  // Keep the clock centered in its existing slot while shrinking it by 10%.
  clock: { x: 522, y: -274, width: 156, height: 156 },
  tasks: { x: -476, y: 218, width: 224, height: 196 },
  agents: [
    { x: 410, y: 191, width: 180, height: 198 },
    { x: 214, y: -369, width: 180, height: 198 },
  ],
} as const;

export function hasArrangedStarterHome(): boolean {
  try {
    return (
      localStorage.getItem(STARTER_HOME_LAYOUT_STORAGE_KEY) === "1" ||
      PREVIOUS_STARTER_HOME_LAYOUT_STORAGE_KEYS.some(
        (key) => localStorage.getItem(key) === "1",
      )
    );
  } catch {
    return false;
  }
}

export function markStarterHomeLayoutEligible(): void {
  try {
    localStorage.setItem(STARTER_HOME_LAYOUT_ELIGIBLE_STORAGE_KEY, "1");
  } catch {
    // Home remains usable when localStorage is unavailable.
  }
}

export function isStarterHomeLayoutEligible(): boolean {
  try {
    return (
      localStorage.getItem(STARTER_HOME_LAYOUT_ELIGIBLE_STORAGE_KEY) === "1"
    );
  } catch {
    return false;
  }
}

export function clearStarterHomeLayoutEligibility(): void {
  try {
    localStorage.removeItem(STARTER_HOME_LAYOUT_ELIGIBLE_STORAGE_KEY);
  } catch {
    // Home remains usable when localStorage is unavailable.
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
    clearStarterHomeLayoutEligibility();
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
    localStorage.removeItem(STARTER_HOME_LAYOUT_ELIGIBLE_STORAGE_KEY);
    clearPendingStarterHomeCamera();
    for (const key of PREVIOUS_STARTER_HOME_LAYOUT_STORAGE_KEYS) {
      localStorage.removeItem(key);
    }
  } catch {
    // Home remains usable when localStorage is unavailable.
  }
}
