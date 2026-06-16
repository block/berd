import { describe, expect, it } from "vitest";

import { TOOL_GROUPS } from "@/features/goosectl/commands/registry";
import { commandBridgeTimeoutMs } from "@/features/goosectl/commands/timeouts";

// The broker clamp (MAX_COMMAND_TIMEOUT, 150s) and the CLI's HTTP timeout
// (160s) are Rust constants; this pins the renderer side of the cross-layer
// ordering so timeouts.ts's claim is enforced where it can be.
describe("goosectl bridge timeout ordering", () => {
  it("keeps every bridge timeout under the broker ceiling (150s) and CLI HTTP timeout (160s)", () => {
    for (const group of Object.values(TOOL_GROUPS)) {
      for (const command of Object.values(group.actions)) {
        expect(commandBridgeTimeoutMs(command)).toBeLessThanOrEqual(150_000);
      }
    }
  });
});
