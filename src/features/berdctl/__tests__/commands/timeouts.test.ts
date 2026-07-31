import { describe, expect, it } from "vitest";

import { TOOL_GROUPS } from "@/features/berdctl/commands/registry";
import { commandBridgeTimeoutMs } from "@/features/berdctl/commands/timeouts";

// The broker clamp (MAX_COMMAND_TIMEOUT, 900s) and the CLI's HTTP timeout
// (910s) are Rust constants; this pins the renderer side of the cross-layer
// ordering so timeouts.ts's claim is enforced where it can be.
describe("berdctl bridge timeout ordering", () => {
  it("keeps every bridge timeout under the broker ceiling (900s) and CLI HTTP timeout (910s)", () => {
    for (const group of Object.values(TOOL_GROUPS)) {
      for (const command of Object.values(group.actions)) {
        expect(commandBridgeTimeoutMs(command)).toBeLessThanOrEqual(900_000);
      }
    }
  });
});
