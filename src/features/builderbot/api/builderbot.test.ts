import { describe, expect, it } from "vitest";
import { builderbotReferenceDisplayName } from "./builderbot";

describe("builderbotReferenceDisplayName", () => {
  it("makes references readable without removing meaningful prefixes", () => {
    expect(builderbotReferenceDisplayName("block-app-kit-weekly-digest")).toBe(
      "Block app kit weekly digest",
    );
    expect(builderbotReferenceDisplayName("sa-builderbot-test")).toBe(
      "SA BuilderBot test",
    );
    expect(
      builderbotReferenceDisplayName("monthly-ai-tool-usage-vcisneros-team"),
    ).toBe("Monthly AI tool usage vcisneros team");
    expect(builderbotReferenceDisplayName("hourly-slack-update")).toBe(
      "Hourly Slack update",
    );
    expect(
      builderbotReferenceDisplayName("banking-client-sentry-fixer-bb-receipts"),
    ).toBe("Banking client Sentry fixer BB receipts");
  });

  it("only strips the exact current-user namespace prefix", () => {
    expect(
      builderbotReferenceDisplayName("morganm-daily-joke-doc", "morganm"),
    ).toBe("Daily joke doc");
    expect(
      builderbotReferenceDisplayName(
        "monthly-ai-tool-usage-vcisneros-team",
        "vcisneros",
      ),
    ).toBe("Monthly AI tool usage vcisneros team");
  });
});
