import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface FileImportZoneOptions {
  onImportFile: (fileBytes: Uint8Array, fileName: string) => void;
  validateFile?: (file: Pick<File, "name" | "type" | "size">) => string | null;
  onImportError?: (message: string) => void;
  maxBytes?: number;
  fileTooLargeMessage?: string;
}

/**
 * Shared drag-and-drop + file-picker infrastructure for import zones.
 * Returns state, handlers, and a ref for the hidden `<input type="file">`.
 */
export function useFileImportZone({
  onImportFile,
  validateFile,
  onImportError,
  maxBytes,
  fileTooLargeMessage,
}: FileImportZoneOptions) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const [isDragOver, setIsDragOver] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      importGenerationRef.current += 1;
    };
  }, []);

  const importFile = useCallback(
    async (file: File) => {
      const generation = ++importGenerationRef.current;
      const validationMessage = validateFile?.(file);
      if (validationMessage) {
        onImportError?.(validationMessage);
        return;
      }
      if (typeof maxBytes === "number" && file.size > maxBytes) {
        onImportError?.(
          fileTooLargeMessage ??
            `File is too large. Choose a file no larger than ${maxBytes} bytes.`,
        );
        return;
      }
      try {
        const buffer = await file.arrayBuffer();
        if (!mountedRef.current || generation !== importGenerationRef.current) {
          return;
        }
        onImportFile(new Uint8Array(buffer), file.name);
      } catch (error) {
        if (mountedRef.current && generation === importGenerationRef.current) {
          onImportError?.(
            error instanceof Error ? error.message : "Failed to read file",
          );
        }
      }
    },
    [fileTooLargeMessage, maxBytes, onImportFile, onImportError, validateFile],
  );

  const dropHandlers = useMemo(
    () => ({
      onDragLeave: () => setIsDragOver(false),
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(true);
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);
        const file = e.dataTransfer.files[0];
        if (file) {
          void importFile(file);
        }
      },
    }),
    [importFile],
  );

  const invalidateImport = useCallback(() => {
    importGenerationRef.current += 1;
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      void importFile(file);
      e.target.value = "";
    },
    [importFile],
  );

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  return {
    fileInputRef,
    isDragOver,
    dropHandlers,
    importFile,
    invalidateImport,
    handleFileChange,
    openFilePicker,
  };
}
