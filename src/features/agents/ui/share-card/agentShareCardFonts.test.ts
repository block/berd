import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_CARD_FONT_LOAD_TIMEOUT_MS,
  loadAgentCardFonts,
} from "./agentShareCardFonts";

describe("loadAgentCardFonts", () => {
  afterEach(() => vi.useRealTimers());

  it("stops waiting when font loading stalls", async () => {
    vi.useFakeTimers();
    const originalFonts = document.fonts;
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { load: vi.fn(() => new Promise(() => undefined)) },
    });

    const result = loadAgentCardFonts();
    await vi.advanceTimersByTimeAsync(AGENT_CARD_FONT_LOAD_TIMEOUT_MS);
    await expect(result).resolves.toBe("timeout");

    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: originalFonts,
    });
  });
});
