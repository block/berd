import { zipSync } from "fflate";

export function createStoredAgentZip(
  pngFilename: string,
  contents: Uint8Array,
): Uint8Array {
  return zipSync({ [pngFilename]: [contents, { level: 0 }] }, { level: 0 });
}
