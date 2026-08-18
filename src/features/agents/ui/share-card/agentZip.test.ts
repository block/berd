import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { createStoredAgentZip } from "./agentZip";

describe("createStoredAgentZip", () => {
  it("stores the portable PNG under its agent filename", () => {
    const contents = new Uint8Array([1, 2, 3, 4]);

    const archive = unzipSync(
      createStoredAgentZip("reviewer.agent.png", contents),
    );

    expect(Object.keys(archive)).toEqual(["reviewer.agent.png"]);
    expect(archive["reviewer.agent.png"]).toEqual(contents);
  });
});
