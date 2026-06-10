import { describe, expect, it } from "vitest";
import { getToolLabel } from "./toolLabels";

describe("getToolLabel", () => {
  it("returns the human-readable label for a known tool", () => {
    expect(getToolLabel("slack__post_message")).toBe("Post to Slack");
    expect(getToolLabel("linear__execute_readonly_query")).toBe(
      "Search Linear",
    );
  });

  it("returns the app-local label for a tool g2 does not define", () => {
    expect(getToolLabel("tile__render_tile")).toBe("Update automation draft");
  });

  it("falls back to the raw tool name for an unknown tool", () => {
    expect(getToolLabel("mystery__do_thing")).toBe("mystery__do_thing");
    expect(getToolLabel("slack")).toBe("slack");
  });
});
