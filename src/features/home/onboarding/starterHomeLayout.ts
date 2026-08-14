const STARTER_HOME_LAYOUT_STORAGE_KEY = "goose:home:starter-layout-v18";

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
  // Match the reference composition: a large project cube anchors the center,
  // agents orbit it at upper-left and bottom-left, and utility widgets stay on
  // the right. Berdy's tour avatar is the upper-left agent.
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
