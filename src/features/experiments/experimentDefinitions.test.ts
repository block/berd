import { describe, expect, it } from "vitest";
import {
  EXPERIMENT_DEFINITIONS,
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
});
