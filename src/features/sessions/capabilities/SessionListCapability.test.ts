import { describe, expect, it } from "vitest";
import { validateDisplayOptions } from "./SessionListCapability";

const defaults = {
  pinnedShowChatIcons: true,
  pinnedShowTimestamps: true,
  projectShowChatIcons: false,
  projectShowTimestamps: true,
  chatShowChatIcons: false,
  chatShowTimestamps: true,
};

describe("validateDisplayOptions", () => {
  it("migrates unified legacy settings into each section", () => {
    expect(
      validateDisplayOptions(
        {
          showChatIcons: true,
          showTimestamps: false,
        },
        defaults,
      ),
    ).toEqual({
      pinnedShowChatIcons: true,
      pinnedShowTimestamps: false,
      projectShowChatIcons: true,
      projectShowTimestamps: false,
      chatShowChatIcons: true,
      chatShowTimestamps: false,
    });
  });

  it("migrates legacy project-specific settings", () => {
    expect(
      validateDisplayOptions(
        {
          showChatIcons: false,
          showTimestamps: true,
          showProjectChatIcons: true,
          showProjectTimestamps: false,
        },
        defaults,
      ),
    ).toMatchObject({
      projectShowChatIcons: true,
      projectShowTimestamps: false,
      chatShowChatIcons: false,
      chatShowTimestamps: true,
    });
  });

  it("preserves independent section settings", () => {
    const settings = {
      pinnedShowChatIcons: false,
      pinnedShowTimestamps: false,
      projectShowChatIcons: true,
      projectShowTimestamps: true,
      chatShowChatIcons: false,
      chatShowTimestamps: true,
    };
    expect(validateDisplayOptions(settings, defaults)).toEqual(settings);
  });
});
