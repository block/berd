import { createStoredAgentZip } from "./agentZip";

interface AgentZipRequest {
  pngFilename: string;
  contents: Uint8Array;
}

self.onmessage = ({ data }: MessageEvent<AgentZipRequest>) => {
  try {
    const archive = createStoredAgentZip(data.pngFilename, data.contents);
    self.postMessage({ archive }, { transfer: [archive.buffer] });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
