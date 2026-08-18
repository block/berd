import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  type DistributionSinkEvent,
  distributionSink,
} from "./distributionSink";

// The seam's stock half: a distro overlay replaces the module with a real
// implementation, so what these pin is that the *stock* build carries it as
// pure dead weight. The client-side half of the contract — which events cross
// the seam, with what shape, and that a throwing replacement cannot disturb
// emission — is pinned in `client.test.ts`.
describe("stock distribution sink", () => {
  it("is a pure no-op that touches nothing", () => {
    const event: DistributionSinkEvent = {
      name: "berd_chat_message_sent",
      attributes: { session_id: "abc123" },
      firedAt: "2026-08-14T00:00:00.000Z",
    };
    const snapshot = structuredClone(event);

    expect(distributionSink(event)).toBeUndefined();

    // Inert includes the input: a stock build must behave exactly as if the
    // call were not there.
    expect(event).toEqual(snapshot);
  });

  it("imports nothing, so the stock module cannot reach transport or invoke machinery", () => {
    // Zero import statements is the strongest static form of the module's
    // promise — no transport, no invoke, no side effects in stock builds. A
    // change that adds one should have to defend itself here.
    // Resolved from the repo root (vitest's cwd): under jsdom,
    // `import.meta.url` is an http URL that node:fs cannot read from.
    const source = readFileSync(
      join(process.cwd(), "src/shared/telemetry/distributionSink.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/^\s*import\b/m);
  });
});
