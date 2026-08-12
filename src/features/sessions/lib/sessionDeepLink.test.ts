import { describe, expect, it } from "vitest";
import { createSessionDeepLink, parseSessionDeepLink } from "./sessionDeepLink";

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

describe("parseSessionDeepLink", () => {
  it("parses session host links", () => {
    expect(parseSessionDeepLink("berd://session/abc-123")).toBe("abc-123");
  });

  it("parses uppercase scheme links", () => {
    expect(parseSessionDeepLink("BERD://session/abc-123")).toBe("abc-123");
  });

  it("parses session path links", () => {
    expect(parseSessionDeepLink("berd:///session/abc-123")).toBe("abc-123");
  });

  it("percent-decodes session IDs", () => {
    expect(parseSessionDeepLink("berd://session/id%2Fwith%20spaces")).toBe(
      "id/with spaces",
    );
  });

  it.each([
    "berd://connect-return",
    "https://example.com/session/abc",
    "berd:/session/session-1",
    "berd:session/session-1",
    " berd:///session/session-1",
    "berd:///session/session-1 ",
    "berd://session/",
    "berd:///session/",
    "berd://session/a/b",
    "berd://session/abc/",
    "berd://session/a//b",
    "berd://session/%FF",
    "berd://SESSION/session-1",
  ])("ignores links outside the session route %s", (href) => {
    expect(parseSessionDeepLink(href)).toBeNull();
  });
});
