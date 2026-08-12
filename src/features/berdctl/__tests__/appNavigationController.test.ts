import { afterEach, describe, expect, it } from "vitest";

import {
  type AppNavigationController,
  clearAppNavigationController,
  getAppNavigationController,
  registerAppNavigationController,
} from "@/features/berdctl/bridge/appNavigationController";

function makeController(): AppNavigationController {
  return {
    openSession: async () => ({ ok: true }),
    archiveSession: async () => ({ ok: true }),
    getAppContext: () => ({
      view: "home",
      activeSessionId: null,
      activeProjectId: null,
    }),
  };
}

afterEach(() => {
  clearAppNavigationController();
});

describe("appNavigationController registry", () => {
  it("throws when no controller is registered", () => {
    expect(() => getAppNavigationController()).toThrow(
      "AppNavigationController not registered",
    );
  });

  it("returns the registered controller", () => {
    const controller = makeController();
    registerAppNavigationController(controller);

    expect(getAppNavigationController()).toBe(controller);
  });

  it("clears only when the given instance is the registered one", () => {
    const stale = makeController();
    const current = makeController();
    registerAppNavigationController(stale);
    registerAppNavigationController(current);

    // A stale effect cleanup must not clear its successor.
    clearAppNavigationController(stale);
    expect(getAppNavigationController()).toBe(current);

    clearAppNavigationController(current);
    expect(() => getAppNavigationController()).toThrow();
  });

  it("clears unconditionally when called without an instance", () => {
    registerAppNavigationController(makeController());

    clearAppNavigationController();
    expect(() => getAppNavigationController()).toThrow();
  });
});
