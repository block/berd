import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

interface OpenAiApiKeyFieldProps {
  label: string;
  configured: boolean;
  onSave: (apiKey: string) => Promise<void>;
  onClear: () => Promise<void>;
}

export function OpenAiApiKeyField({
  label,
  configured,
  onSave,
  onClear,
}: OpenAiApiKeyFieldProps) {
  const { t } = useTranslation("settings");
  const inputId = useId();
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(apiKey);
      setApiKey("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setSaving(true);
    setError(null);
    try {
      await onClear();
      setApiKey("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <label htmlFor={inputId} className="text-xs font-medium">
        {label}
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id={inputId}
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={configured ? t("voice.openAiApiKeySaved") : "sk-…"}
          autoComplete="off"
          spellCheck={false}
        />
        <Button
          type="button"
          size="sm"
          onClick={() => void save()}
          disabled={saving || !apiKey.trim()}
        >
          {t("voice.saveApiKey")}
        </Button>
        {configured ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void clear()}
            disabled={saving}
          >
            {t("voice.removeApiKey")}
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {configured
          ? t("voice.openAiApiKeyConfigured")
          : t("voice.openAiApiKeyNotConfigured")}
      </p>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
