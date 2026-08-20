import { describe, expect, it } from "vitest";
import { AGENT_CARD_GEOMETRY } from "./agentShareCardGeometry";

describe("AGENT_CARD_GEOMETRY", () => {
  it("balances the avatar between the header and title content", () => {
    const { avatar, brand, title } = AGENT_CARD_GEOMETRY;
    const gapBelowHeader = avatar.y - brand.y;
    const gapAboveTitle = title.y - 64 - (avatar.y + avatar.height);

    expect(Math.abs(gapBelowHeader - gapAboveTitle)).toBeLessThanOrEqual(8);
  });

  it("balances the card's top and bottom content padding", () => {
    const { panel, logo, description } = AGENT_CARD_GEOMETRY;
    const topPadding = logo.y - panel.y;
    const maximumDescriptionBottom = description.y + 2 * description.lineHeight;
    const bottomPadding = panel.y + panel.height - maximumDescriptionBottom;

    expect(Math.abs(topPadding - bottomPadding)).toBeLessThanOrEqual(8);
  });
});
