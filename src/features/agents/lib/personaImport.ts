import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import {
  isJsonImportFileName,
  isPersonaMarkdownImportFileName,
} from "@/shared/lib/personaImportFileName";

const JSON_MIME_TYPES = new Set([
  "",
  "application/json",
  "application/x-json",
  "text/json",
  "text/plain",
]);
const MARKDOWN_MIME_TYPES = new Set([
  "",
  "text/markdown",
  "text/plain",
  "application/octet-stream",
]);

export const MAX_PERSONA_IMPORT_BYTES = 4 * 1024 * 1024;

export interface ImportMessageDescriptor {
  key:
    | "view.importInvalidExtension"
    | "view.importInvalidMimeType"
    | "view.importTooLarge"
    | "view.imported_one"
    | "view.imported_other";
  options?: Record<string, unknown>;
}

export function formatPersonaImportFileSize(bytes: number): string {
  return `${Math.floor(bytes / (1024 * 1024))} MB`;
}

export function validatePersonaImportFile(
  file: Pick<File, "name" | "type"> & { size?: number },
): ImportMessageDescriptor | null {
  const isJson = isJsonImportFileName(file.name);
  const isPersonaMarkdown = isPersonaMarkdownImportFileName(file.name);
  if (!isJson && !isPersonaMarkdown) {
    return {
      key: "view.importInvalidExtension",
    } satisfies ImportMessageDescriptor;
  }

  const allowedMimeTypes = isPersonaMarkdown
    ? MARKDOWN_MIME_TYPES
    : JSON_MIME_TYPES;
  if (!allowedMimeTypes.has(file.type)) {
    return {
      key: "view.importInvalidMimeType",
    } satisfies ImportMessageDescriptor;
  }

  if (typeof file.size === "number" && file.size > MAX_PERSONA_IMPORT_BYTES) {
    return {
      key: "view.importTooLarge",
      options: {
        maxSize: formatPersonaImportFileSize(MAX_PERSONA_IMPORT_BYTES),
      },
    } satisfies ImportMessageDescriptor;
  }

  return null;
}

export function formatImportSuccessMessage(
  importedCount: number,
): ImportMessageDescriptor {
  if (importedCount === 1) {
    return { key: "view.imported_one", options: { count: importedCount } };
  }

  return {
    key: "view.imported_other",
    options: { count: importedCount },
  };
}

export function formatAgentError(error: unknown, fallback: string): string {
  return formatAcpErrorMessage(error, fallback);
}
