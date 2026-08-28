import { describe, expect, it } from "vitest";
import {
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
});
