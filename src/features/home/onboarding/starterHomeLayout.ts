const STARTER_HOME_LAYOUT_STORAGE_KEY = "goose:home:starter-layout-v14";

const STARTER_TASK_ROW_HEIGHT = 32;

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
  project: { x: -232, y: -300, width: 680, height: 680 },
  berdy: { x: -352, y: -180 },
  clock: { x: 500, y: -300 },
  tasks: { x: 440, y: 120, width: 280, height: 248 },
  agents: [
    { x: 228, y: -380, width: 200, height: 220 },
    { x: -292, y: 260, width: 200, height: 220 },
    { x: 348, y: 300, width: 200, height: 220 },
  ],
} as const;

export function hasArrangedStarterHome(): boolean {
  try {
    return localStorage.getItem(STARTER_HOME_LAYOUT_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markStarterHomeArranged(): void {
  try {
    localStorage.setItem(STARTER_HOME_LAYOUT_STORAGE_KEY, "1");
  } catch {
    // Home remains usable when localStorage is unavailable.
  }
}

export function resetStarterHomeArrangement(): void {
  try {
    localStorage.removeItem(STARTER_HOME_LAYOUT_STORAGE_KEY);
  } catch {
    // Home remains usable when localStorage is unavailable.
  }
}
