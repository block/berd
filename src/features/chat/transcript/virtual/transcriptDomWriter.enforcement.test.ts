import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const NORMAL_PATH_FILES = [
  "src/features/chat/ui/VirtualMessageTimeline.tsx",
  "src/features/chat/transcript/virtual/react/useTranscriptVirtualTimeline.ts",
];

/** Guards the architectural boundary: components/hooks may read geometry, but
 * only the browser viewport adapter may write the transcript DOM. */
describe("transcript DOM writer boundary", () => {
  it.each(NORMAL_PATH_FILES)("keeps direct scroll writes out of %s", (file) => {
    const source = readFileSync(resolve(process.cwd(), file), "utf8");
    expect(source).not.toMatch(/\.scrollTop\s*=/);
    expect(source).not.toMatch(/\.scroll(?:To|By)\s*\(/);
    expect(source).not.toMatch(/\.scrollIntoView\s*\(/);
  });
});
