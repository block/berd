import { describe, expect, it } from "vitest";
import {
  STARTER_TASKS,
  isStarterTaskComplete,
  omittedStarterTasksAfterFirstRun,
} from "./starterTasks";

const incomplete = {
  "connect-provider": false,
  "start-chat": false,
  "create-project": false,
  "add-widget": false,
};

describe("starter task model", () => {
  it("defines the requested tasks in order", () => {
    expect(STARTER_TASKS.map((task) => task.id)).toEqual([
      "connect-provider",
      "start-chat",
      "create-project",
      "add-widget",
    ]);
  });

  it("reads completion from the derived state", () => {
    expect(isStarterTaskComplete(incomplete, "start-chat")).toBe(false);
    expect(
      isStarterTaskComplete(
        { ...incomplete, "start-chat": true },
        "start-chat",
      ),
    ).toBe(true);
  });

  it("omits provider setup only after completed onboarding handled it", () => {
    expect(
      omittedStarterTasksAfterFirstRun({
        onboardingCompleted: true,
        providerHandled: true,
      }),
    ).toEqual(new Set(["connect-provider"]));
  });

  it.each([
    [false, true],
    [true, false],
    [false, false],
  ])("keeps provider setup for completed=%s handled=%s", (onboardingCompleted, providerHandled) => {
    expect(
      omittedStarterTasksAfterFirstRun({
        onboardingCompleted,
        providerHandled,
      }),
    ).toEqual(new Set());
  });
});
