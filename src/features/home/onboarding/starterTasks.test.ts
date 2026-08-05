import { describe, expect, it } from "vitest";
import { STARTER_TASKS, isStarterTaskComplete } from "./starterTasks";

const incomplete = {
  "connect-provider": false,
  "start-chat": false,
  "create-project": false,
  "build-agent": false,
};

describe("starter task model", () => {
  it("defines the four requested tasks in order", () => {
    expect(STARTER_TASKS.map((task) => task.id)).toEqual([
      "connect-provider",
      "start-chat",
      "create-project",
      "build-agent",
    ]);
  });

  it("reads completion from the derived state", () => {
    expect(isStarterTaskComplete(incomplete, "build-agent")).toBe(false);
    expect(
      isStarterTaskComplete(
        { ...incomplete, "build-agent": true },
        "build-agent",
      ),
    ).toBe(true);
  });
});
