import { describe, expect, it } from "vitest";
import { validateDisplayOptions } from "./SessionListCapability";

const defaults = {
  showChatIcons: false,
  showTimestamps: true,
};

describe("validateDisplayOptions", () => {
  it("migrates former grouped-project display settings to unified settings", () => {
    expect(
      validateDisplayOptions(
        {
          showChatIcons: true,
          showProjectChatIcons: false,
          showTimestamps: false,
          showProjectTimestamps: true,
        },
        defaults,
      ),
    ).toEqual(defaults);
  });

  it("uses unified settings after legacy fields have been removed", () => {
    expect(
      validateDisplayOptions(
        {
          showChatIcons: true,
          showTimestamps: false,
        },
        defaults,
      ),
    ).toEqual({
      showChatIcons: true,
      showTimestamps: false,
    });
  });
});
