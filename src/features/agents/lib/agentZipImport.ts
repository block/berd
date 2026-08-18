import { unzipSync } from "fflate";
import { MAX_SNAPSHOT_PNG_BYTES } from "@/features/agents/agent-snapshot";
import { MAX_PERSONA_IMPORT_BYTES } from "@/features/agents/lib/personaImport";

const MAX_ARCHIVE_ENTRIES = 32;

export type AgentZipImportErrorCode =
  | "invalid"
  | "tooManyFiles"
  | "tooLarge"
  | "missingAgent"
  | "multipleAgents";

export class AgentZipImportError extends Error {
  constructor(
    public readonly code: AgentZipImportErrorCode,
    public readonly maxBytes?: number,
  ) {
    super(code);
    this.name = "AgentZipImportError";
  }
}

export interface ExtractedAgentFile {
  bytes: Uint8Array;
  name: string;
}

export function isAgentZipFileName(fileName: string): boolean {
  return fileName.trim().toLowerCase().endsWith(".zip");
}

function isAgentImageFileName(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(".png");
}

function isSupportedAgentFileName(fileName: string): boolean {
  const lowerName = fileName.toLowerCase();
  return (
    isAgentImageFileName(lowerName) ||
    lowerName.endsWith(".md") ||
    lowerName.endsWith(".json")
  );
}

function maxAgentFileBytes(fileName: string): number {
  return isAgentImageFileName(fileName)
    ? MAX_SNAPSHOT_PNG_BYTES
    : MAX_PERSONA_IMPORT_BYTES;
}

function validateExtractedSize(fileName: string, size: number): void {
  const maxBytes = maxAgentFileBytes(fileName);
  if (size > maxBytes) {
    throw new AgentZipImportError("tooLarge", maxBytes);
  }
}

export function extractAgentFileFromZip(
  archiveBytes: Uint8Array,
): ExtractedAgentFile {
  let entryCount = 0;
  let totalUncompressedBytes = 0;
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(archiveBytes, {
      filter(entry) {
        entryCount += 1;
        if (entryCount > MAX_ARCHIVE_ENTRIES) {
          throw new AgentZipImportError("tooManyFiles");
        }
        totalUncompressedBytes += entry.originalSize;
        if (totalUncompressedBytes > MAX_SNAPSHOT_PNG_BYTES) {
          throw new AgentZipImportError("tooLarge", MAX_SNAPSHOT_PNG_BYTES);
        }
        const name = entry.name.split("/").at(-1) ?? "";
        if (
          !entry.name.endsWith("/") &&
          !entry.name.split("/").includes("__MACOSX") &&
          !name.startsWith(".") &&
          isSupportedAgentFileName(name) &&
          entry.originalSize > maxAgentFileBytes(name)
        ) {
          throw new AgentZipImportError("tooLarge", maxAgentFileBytes(name));
        }
        return !entry.name.endsWith("/");
      },
    });
  } catch (error) {
    if (error instanceof AgentZipImportError) throw error;
    throw new AgentZipImportError("invalid");
  }

  const candidates = Object.entries(archive).filter(([path]) => {
    const parts = path.split("/");
    const name = parts.at(-1) ?? "";
    return (
      !parts.includes("__MACOSX") &&
      !name.startsWith(".") &&
      isSupportedAgentFileName(name)
    );
  });

  if (candidates.length === 0) {
    throw new AgentZipImportError("missingAgent");
  }
  if (candidates.length > 1) {
    throw new AgentZipImportError("multipleAgents");
  }

  const [path, bytes] = candidates[0];
  const name = path.split("/").at(-1) ?? path;
  validateExtractedSize(name, bytes.length);
  return { bytes, name };
}
