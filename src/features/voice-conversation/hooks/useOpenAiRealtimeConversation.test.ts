import { describe, expect, it } from "vitest";

import { renderRealtimeBackendDelivery } from "./useOpenAiRealtimeConversation";

describe("GPT Live delegation rendering", () => {
  it("preserves the ordered transcript delta and opaque delegation id", () => {
    expect(
      renderRealtimeBackendDelivery([
        { cursor: 4, role: "user", text: "What changed?" },
        { cursor: 5, role: "gpt_live", text: "I’ll check." },
        {
          cursor: 6,
          role: "handoff",
          handoffId: "dlg_123",
          text: "Handle the unresolved user request.",
        },
      ]),
    ).toBe(
      "[Voice transcript; cursor 4] User said: What changed?\n" +
        "[Voice transcript; cursor 5] GPT Live said: I’ll check.\n" +
        "[Delegation dlg_123 from GPT Live; cursor 6] Handle the unresolved user request.",
    );
  });
});
