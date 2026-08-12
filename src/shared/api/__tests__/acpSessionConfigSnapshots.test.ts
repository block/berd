import { describe, expect, it } from "vitest";

import {
  readSessionConfigOptionsSnapshots,
  readSessionExecutionConfigSnapshot,
} from "../acpSessionConfigSnapshots";

const gooseModelSnapshot = {
  configOptions: [
    {
      id: "provider",
      kind: { type: "select", currentValue: "databricks_v2", options: [] },
    },
    {
      id: "model",
      category: "model",
      kind: { type: "select", currentValue: "goose", options: [] },
    },
  ],
};

describe("ACP session config snapshots", () => {
  it("rejects the goose sentinel from model and execution snapshots", () => {
    expect(
      readSessionConfigOptionsSnapshots(gooseModelSnapshot).model,
    ).toBeNull();
    expect(readSessionExecutionConfigSnapshot(gooseModelSnapshot)).toBeNull();
  });
});
