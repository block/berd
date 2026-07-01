import { describe, expect, it } from "vitest";
import { resolveNavigationPrototypePrimaryCollapsed } from "./navigationPrototypeState";

describe("resolveNavigationPrototypePrimaryCollapsed", () => {
  it("keeps hybrid prototype nav collapsed by default and expands only while primary is hovered", () => {
    expect(
      resolveNavigationPrototypePrimaryCollapsed({
        mode: "hybrid-push-overlay",
        navigationPrimaryHovered: false,
        prototypePrimaryRestCollapsed: false,
        prototypeSecondaryOpen: false,
      }),
    ).toBe(true);

    expect(
      resolveNavigationPrototypePrimaryCollapsed({
        mode: "hybrid-push-overlay",
        navigationPrimaryHovered: true,
        prototypePrimaryRestCollapsed: false,
        prototypeSecondaryOpen: false,
      }),
    ).toBe(false);
  });

  it("does not let secondary nav state expand hybrid prototype primary nav", () => {
    expect(
      resolveNavigationPrototypePrimaryCollapsed({
        mode: "hybrid-push-overlay",
        navigationPrimaryHovered: false,
        prototypePrimaryRestCollapsed: false,
        prototypeSecondaryOpen: true,
      }),
    ).toBe(true);
  });

  it("keeps the prototype primary nav expanded by default on the home canvas", () => {
    expect(
      resolveNavigationPrototypePrimaryCollapsed({
        mode: "hybrid-push-overlay",
        navigationPrimaryHovered: false,
        prototypePrimaryDefaultExpanded: true,
        prototypePrimaryRestCollapsed: false,
        prototypeSecondaryOpen: false,
      }),
    ).toBe(false);
  });

  it("keeps rest-collapsed chat state collapsed even when default-expanded is requested", () => {
    expect(
      resolveNavigationPrototypePrimaryCollapsed({
        mode: "hybrid-push-overlay",
        navigationPrimaryHovered: false,
        prototypePrimaryDefaultExpanded: true,
        prototypePrimaryRestCollapsed: true,
        prototypeSecondaryOpen: false,
      }),
    ).toBe(true);
  });
});
