import { describe, expect, it } from "vitest";
import { createSessionDeepLink } from "./sessionDeepLink";

describe("createSessionDeepLink", () => {
  it("creates a Berd session link", () => {
    expect(createSessionDeepLink("session-1")).toBe("berd://session/session-1");
  });

  it("encodes session IDs as one path segment", () => {
    expect(createSessionDeepLink("id/with spaces?#%✓")).toBe(
      "berd://session/id%2Fwith%20spaces%3F%23%25%E2%9C%93",
    );
  });
});
