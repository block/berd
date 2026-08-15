const STARTER_HOME_LAYOUT_STORAGE_KEY = "goose:home:starter-layout-v16";
const PREVIOUS_STARTER_HOME_LAYOUT_STORAGE_KEYS = [
  "goose:home:starter-layout-v14",
  "goose:home:starter-layout-v15",
] as const;
const STARTER_HOME_LAYOUT_ELIGIBLE_STORAGE_KEY =
  "goose:home:starter-layout-eligible-v1";

const STARTER_TASK_ROW_HEIGHT = 28;

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
  berdy: { x: -352, y: -180 },
  // Preserve the former 240×240 clock's center while shrinking its footprint.
  clock: { x: 533.5, y: -266.5, width: 173, height: 173 },
  tasks: { x: 440, y: 120, width: 256, height: 224 },
  agents: [
    { x: 228, y: -380, width: 200, height: 220 },
    { x: -292, y: 260, width: 200, height: 220 },
    { x: 348, y: 300, width: 200, height: 220 },
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

export function markStarterHomeArranged(): void {
  try {
    localStorage.setItem(STARTER_HOME_LAYOUT_STORAGE_KEY, "1");
    clearStarterHomeLayoutEligibility();
  } catch {
    // Home remains usable when localStorage is unavailable.
  }
}

export function resetStarterHomeArrangement(): void {
  try {
    localStorage.removeItem(STARTER_HOME_LAYOUT_STORAGE_KEY);
    localStorage.removeItem(STARTER_HOME_LAYOUT_ELIGIBLE_STORAGE_KEY);
    for (const key of PREVIOUS_STARTER_HOME_LAYOUT_STORAGE_KEYS) {
      localStorage.removeItem(key);
    }
  } catch {
    // Home remains usable when localStorage is unavailable.
  }
}
