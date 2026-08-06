import { describe, expect, it } from "vitest";
import { normalizeGloopieGenerationError } from "./gloopies";

describe("normalizeGloopieGenerationError", () => {
  it("preserves content-blocked errors from the native command", () => {
    const error = normalizeGloopieGenerationError({
      code: "contentBlocked",
      message: "The image provider couldn't use that description.",
    });

    expect(error.code).toBe("contentBlocked");
    expect(error.message).toContain("image provider");
  });
});
