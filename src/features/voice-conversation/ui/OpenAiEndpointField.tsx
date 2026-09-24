import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getOpenAiVoiceEndpoints,
  setOpenAiVoiceEndpoint,
  type OpenAiVoiceEndpointKind,
} from "../api/openAiVoice";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

const DEFAULT_URLS: Record<OpenAiVoiceEndpointKind, string> = {
  realtime: "wss://api.openai.com/v1/realtime",
  stt: "wss://api.openai.com/v1/realtime?intent=transcription",
  tts: "https://api.openai.com/v1/audio/speech",
};

export function OpenAiEndpointField({
  kind,
  label,
}: {
  kind: OpenAiVoiceEndpointKind;
  label: string;
}) {
  const { t } = useTranslation("settings");
  const id = useId();
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getOpenAiVoiceEndpoints().then(
      (settings) => {
        if (active) setUrl(settings[kind] ?? "");
      },
      (cause) => {
        if (active) setError(String(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [kind]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await setOpenAiVoiceEndpoint(kind, url);
      setUrl((await getOpenAiVoiceEndpoints())[kind] ?? "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-xs font-medium">
        {label}
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id={id}
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder={DEFAULT_URLS[kind]}
          autoComplete="off"
          spellCheck={false}
        />
        <Button
          type="button"
          size="sm"
          onClick={() => void save()}
          disabled={saving}
        >
          {t("voice.saveEndpoint")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("voice.endpointDefaultHint")}
      </p>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
