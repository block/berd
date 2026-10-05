import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocaleFormatting } from "@/shared/i18n";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Slider } from "@/shared/ui/slider";
import {
  CONTEXT_LIMIT_SLIDER_STEP,
  MAX_CONTEXT_LIMIT_SLIDER,
  MIN_CONTEXT_LIMIT_SLIDER,
  parseContextLimit,
} from "@/features/chat/lib/contextLimit";
import { useGooseContextLimit } from "../useGooseContextLimit";

export function GooseContextLimitSettings() {
  const { t } = useTranslation("settings");
  const { formatNumber } = useLocaleFormatting();
  const { contextLimit, isHydrated, isReadbackPending, saveContextLimit } =
    useGooseContextLimit();
  const [draft, setDraft] = useState(String(contextLimit));
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const prefix = "compaction.goose.contextLimit";
  const parsedDraft = parseContextLimit(draft);
  const helperId = useId();
  const errorId = useId();
  const displayedError = parsedDraft === null ? t(`${prefix}.invalid`) : error;

  useEffect(() => setDraft(String(contextLimit)), [contextLimit]);

  const save = async (value: unknown) => {
    if (saving.current || !isHydrated) return;
    const parsed = parseContextLimit(value);
    if (parsed === null) {
      setError(t(`${prefix}.invalid`));
      return;
    }
    if (parsed === contextLimit) return;
    saving.current = true;
    setIsSaving(true);
    setError(null);
    try {
      const effectiveLimit = await saveContextLimit(parsed);
      setDraft(String(effectiveLimit));
    } catch {
      setDraft(String(contextLimit));
      setError(t(`${prefix}.saveError`));
    } finally {
      saving.current = false;
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 text-sm">{t(`${prefix}.label`)}</p>
        <span className="shrink-0 text-xs">
          {isHydrated
            ? t(`${prefix}.tokens`, {
                displayCount: formatNumber(parsedDraft ?? contextLimit),
              })
            : t("compaction.goose.autoCompact.loading")}
        </span>
      </div>
      <Slider
        value={[
          Math.min(
            MAX_CONTEXT_LIMIT_SLIDER,
            Math.max(MIN_CONTEXT_LIMIT_SLIDER, parsedDraft ?? contextLimit),
          ),
        ]}
        min={MIN_CONTEXT_LIMIT_SLIDER}
        max={MAX_CONTEXT_LIMIT_SLIDER}
        step={CONTEXT_LIMIT_SLIDER_STEP}
        onValueChange={([value]) => {
          setError(null);
          setDraft(String(value));
        }}
        onValueCommit={([value]) => void save(value)}
        disabled={isSaving || !isHydrated}
        aria-label={t(`${prefix}.label`)}
      />
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save(draft);
        }}
      >
        <Input
          type="number"
          min={1}
          step={1}
          value={draft}
          onChange={(event) => {
            setError(null);
            setDraft(event.target.value);
          }}
          disabled={isSaving || !isHydrated}
          aria-label={t(`${prefix}.exactLabel`)}
          aria-describedby={`${helperId}${displayedError ? ` ${errorId}` : ""}`}
          aria-invalid={parsedDraft === null}
          className="max-w-40"
        />
        <Button
          type="submit"
          size="xs"
          variant="outline"
          disabled={
            !isHydrated || parsedDraft === null || parsedDraft === contextLimit
          }
          feedbackState={isSaving ? "loading" : "idle"}
        >
          {t(`${prefix}.save`)}
        </Button>
      </form>
      <p id={helperId} className="text-[11px] text-muted-foreground">
        {t(`${prefix}.helper`)}
      </p>
      {displayedError ? (
        <p id={errorId} role="alert" className="text-[11px] text-destructive">
          {displayedError}
        </p>
      ) : null}
      {isReadbackPending ? (
        <p role="status" className="text-[11px] text-muted-foreground">
          {t(`${prefix}.readbackPending`)}
        </p>
      ) : null}
    </div>
  );
}
