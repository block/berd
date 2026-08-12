import { describe, expect, it, vi } from "vitest";
import {
  emitSkillsChanged,
  listenSkillsChanged,
  SKILLS_CHANGED_EVENT,
} from "./skillsEvents";

describe("skillsEvents", () => {
  it("notifies listeners and cleans them up", () => {
    const listener = vi.fn();
    const cleanup = listenSkillsChanged(listener);

    emitSkillsChanged();
    expect(listener).toHaveBeenCalledTimes(1);

    cleanup();
    emitSkillsChanged();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("exports the skills changed event name", () => {
    expect(SKILLS_CHANGED_EVENT).toBe("goose:skills-changed");
  });
});
