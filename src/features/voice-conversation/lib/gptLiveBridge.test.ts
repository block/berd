import { afterEach, describe, expect, it, vi } from "vitest";

import { appendToActiveGptLive, registerGptLiveBridge } from "./gptLiveBridge";

describe("GPT Live bridge", () => {
  let release: (() => void) | undefined;

  afterEach(() => release?.());

  it("forwards one provider-shaped append to the active conversation", async () => {
    const append = vi.fn().mockResolvedValue({ accepted: true, cursor: 8 });
    release = registerGptLiveBridge({ sessionId: "session-1", append });

    await expect(
      appendToActiveGptLive(
        "session-1",
        "The build passed.",
        7,
        "commentary",
        "dlg_123",
      ),
    ).resolves.toEqual({ accepted: true, cursor: 8 });
    expect(append).toHaveBeenCalledWith(
      "The build passed.",
      7,
      "commentary",
      "dlg_123",
    );
  });
});
