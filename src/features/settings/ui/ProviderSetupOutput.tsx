import type { Ref } from "react";
import { Check, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { Button } from "@/shared/ui/button";

export interface ProviderSetupOutputLine {
  id: number | string;
  text: string;
}

interface ProviderSetupOutputProps {
  lines: ProviderSetupOutputLine[];
  scrollRef?: Ref<HTMLDivElement>;
}

const DEVICE_CODE_PATTERN = /\b[A-Z0-9]{4}(?:-[A-Z0-9]{4}){1,3}\b/g;
const DEVICE_CODE_CONTEXT_PATTERN =
  /\b(auth|authorization|code|copy|device|enter|login|sign|verification)\b/i;

function findDeviceCode(lines: ProviderSetupOutputLine[]): string | null {
  const hasDeviceCodeContext = lines.some((line) =>
    DEVICE_CODE_CONTEXT_PATTERN.test(line.text),
  );
  if (!hasDeviceCodeContext) {
    return null;
  }

  for (const line of lines) {
    const match = line.text.toUpperCase().match(DEVICE_CODE_PATTERN);
    if (match?.[0]) {
      return match[0];
    }
  }

  return null;
}

export function ProviderSetupOutput({
  lines,
  scrollRef,
}: ProviderSetupOutputProps) {
  const { t } = useTranslation(["settings", "common"]);
  const deviceCode = findDeviceCode(lines);
  const { isCopied, copyToClipboard } = useCopyToClipboard();

  if (lines.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      {deviceCode ? (
        <div className="rounded-sm border border-border bg-muted px-3 py-2 text-foreground">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground">
                {t("providers.setupOutput.deviceCode")}
              </p>
              <p className="mt-1 break-all font-mono text-base leading-6 text-foreground">
                {deviceCode}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => copyToClipboard(deviceCode)}
              leftIcon={isCopied ? <Check /> : <Copy />}
              aria-label={t("providers.setupOutput.copyDeviceCode")}
              className="shrink-0"
            >
              {isCopied
                ? t("common:components.linkSafety.copied")
                : t("common:actions.copy")}
            </Button>
          </div>
        </div>
      ) : null}

      <div
        ref={scrollRef}
        className="max-h-24 overflow-y-auto rounded-sm bg-muted px-2.5 py-2 font-mono text-xs leading-relaxed text-muted-foreground"
      >
        {lines.map((line) => (
          <div key={line.id}>{line.text || "\u00A0"}</div>
        ))}
      </div>
    </div>
  );
}
