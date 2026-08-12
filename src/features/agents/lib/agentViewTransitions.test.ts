import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAgentAvatarTransitionName,
  runAgentViewTransition,
} from "./agentViewTransitions";

function makeViewTransition() {
  const resolved = Promise.resolve();
  return {
    finished: resolved,
    ready: resolved,
    updateCallbackDone: resolved,
    skipTransition: vi.fn(),
  };
}

describe("agentViewTransitions", () => {
  const originalStartViewTransition = document.startViewTransition;

  afterEach(() => {
    if (originalStartViewTransition) {
      Object.defineProperty(document, "startViewTransition", {
        configurable: true,
        value: originalStartViewTransition,
      });
    } else {
      Reflect.deleteProperty(document, "startViewTransition");
    }
    vi.restoreAllMocks();
  });

  it("sanitizes agent ids for view transition names", () => {
    expect(getAgentAvatarTransitionName("agent:Code Reviewer/1")).toBe(
      "agent-avatar-agent_Code_Reviewer_1",
    );
  });

  it("calls document.startViewTransition with the document binding", () => {
    let calledWithDocumentBinding = false;
    let updateRan = false;

    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value(this: Document, updateCallback: () => void) {
        calledWithDocumentBinding = this === document;
        updateCallback();
        return makeViewTransition();
      },
    });

    runAgentViewTransition(() => {
      updateRan = true;
    });

    expect(calledWithDocumentBinding).toBe(true);
    expect(updateRan).toBe(true);
  });
});
