import { describe, expect, it } from "vitest";
import {
  DESKTOP_AGENT_AGENT_SELECTOR_EXPERIMENT_ID,
  EXPERIMENT_DEFINITIONS,
  REMOTE_SSH_SESSIONS_EXPERIMENT_ID,
  VOICE_CONVERSATION_EXPERIMENT_ID,
} from "./experimentDefinitions";

describe("experiment definitions", () => {
  it("defaults Voice Conversation on while preserving explicit overrides", () => {
    expect(
      EXPERIMENT_DEFINITIONS.find(
        (definition) => definition.id === VOICE_CONVERSATION_EXPERIMENT_ID,
      )?.defaultEnabled,
    ).toBe(true);
  });

  it("keeps Remote SSH sessions manual-enable only and visible in settings", () => {
    const definition = EXPERIMENT_DEFINITIONS.find(
      (candidate) => candidate.id === REMOTE_SSH_SESSIONS_EXPERIMENT_ID,
    );
    expect(definition?.manualEnableOnly).toBe(true);
    expect(definition?.settingsVisibility).toBe("all");
  });

  it("keeps only the agent selector behind a Desktop Agent experiment", () => {
    const ids = EXPERIMENT_DEFINITIONS.map(({ id }) => id);
    expect(ids).toContain(DESKTOP_AGENT_AGENT_SELECTOR_EXPERIMENT_ID);
    // The Desktop Agent itself is a General setting now.
    expect(ids).not.toContain("desktop-agent");
  });
});
