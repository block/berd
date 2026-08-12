import { describe, expect, it } from "vitest";
import { selectLocalMessageCountsBySession } from "./chatSelectors";
import type { ChatStore } from "./chatStore";

describe("selectLocalMessageCountsBySession", () => {
  it("keeps a session with a queued first message discoverable", () => {
    const state = {
      messagesBySession: {},
      queuedMessageBySession: {
        draft: [
          {
            kind: "deferred",
            recordId: "record",
            payload: { text: "queued first message" },
            state: {},
          },
        ],
      },
    } as unknown as ChatStore;

    expect(selectLocalMessageCountsBySession(state)).toEqual({ draft: 1 });
  });
});
