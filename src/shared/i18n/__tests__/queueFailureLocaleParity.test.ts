import { describe, expect, it } from "vitest";
import enChat from "../locales/en/chat.json";
import esChat from "../locales/es/chat.json";

const keys = ["backgroundSendFailed", "backgroundSendFailedTitle"] as const;

describe("background queue failure locale parity", () => {
  it("provides translated Spanish copy for every new failure-toast string", () => {
    for (const key of keys) {
      expect(esChat.queue[key]).toBeTruthy();
      expect(esChat.queue[key]).not.toBe(enChat.queue[key]);
    }
  });
});
