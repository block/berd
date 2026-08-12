import { useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { IconPlayerPlay } from "@tabler/icons-react";
import {
  CodeBlock,
  CodeBlockCopyButton,
  CodeBlockDownloadButton,
} from "streamdown";
import {
  isRunnableShellLanguage,
  normalizeRunnableShellCommand,
} from "@/shared/lib/runnableShellCommand";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

export interface RunCommandOptions {
  newTerminal?: boolean;
}

interface RunnableCodeBlockProps {
  code: string;
  language: string;
  isIncomplete?: boolean;
  meta?: string;
  onRun?: (command: string, options?: RunCommandOptions) => void;
}

function selectedTextInside(container: HTMLElement | null): string | null {
  if (!container || typeof window === "undefined") {
    return null;
  }

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (
    !container.contains(range.startContainer) ||
    !container.contains(range.endContainer)
  ) {
    return null;
  }

  const selectedText = selection.toString().trim();
  return selectedText || null;
}

export function RunnableCodeBlock({
  code,
  language,
  isIncomplete,
  onRun,
}: RunnableCodeBlockProps) {
  const { t } = useTranslation("common");
  const blockRef = useRef<HTMLDivElement | null>(null);
  const command = useMemo(() => normalizeRunnableShellCommand(code), [code]);
  const canRun = Boolean(
    onRun && !isIncomplete && command && isRunnableShellLanguage(language),
  );

  const handleRun = useCallback(
    (event: React.MouseEvent) => {
      if (!canRun) {
        return;
      }

      const source = selectedTextInside(blockRef.current) ?? code;
      const commandToRun = normalizeRunnableShellCommand(source);
      if (!commandToRun) {
        return;
      }

      onRun?.(commandToRun, event.metaKey ? { newTerminal: true } : undefined);
    },
    [canRun, code, onRun],
  );

  return (
    <div ref={blockRef} className="contents">
      <CodeBlock code={code} language={language} isIncomplete={isIncomplete}>
        <CodeBlockDownloadButton language={language} />
        {canRun ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="cursor-pointer p-1 text-muted-foreground transition-all hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                onClick={handleRun}
                onMouseDown={(event) => event.preventDefault()}
                aria-label={t("components.codeBlock.runInTerminalLabel")}
              >
                <IconPlayerPlay size={14} aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {t("components.codeBlock.runInTerminalLabel")}
            </TooltipContent>
          </Tooltip>
        ) : null}
        <CodeBlockCopyButton />
      </CodeBlock>
    </div>
  );
}
