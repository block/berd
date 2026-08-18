import { AgentZipImportError, extractAgentFileFromZip } from "./agentZipImport";

self.onmessage = ({ data }: MessageEvent<{ archiveBytes: Uint8Array }>) => {
  try {
    const extracted = extractAgentFileFromZip(data.archiveBytes);
    self.postMessage(extracted, { transfer: [extracted.bytes.buffer] });
  } catch (error) {
    self.postMessage({
      error:
        error instanceof AgentZipImportError
          ? { code: error.code, maxBytes: error.maxBytes }
          : { code: "invalid" },
    });
  }
};
