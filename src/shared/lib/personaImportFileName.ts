const PERSONA_MARKDOWN_IMPORT_PATTERN = /\.md$/i;

export function isPersonaMarkdownImportFileName(fileName: string): boolean {
  return PERSONA_MARKDOWN_IMPORT_PATTERN.test(fileName.trim());
}

export function isJsonImportFileName(fileName: string): boolean {
  return fileName.trim().toLowerCase().endsWith(".json");
}

export function isSupportedPersonaImportFileName(fileName: string): boolean {
  return (
    isPersonaMarkdownImportFileName(fileName) || isJsonImportFileName(fileName)
  );
}
