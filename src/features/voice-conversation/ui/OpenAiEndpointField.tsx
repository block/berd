import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getOpenAiVoiceEndpoints,
  getOpenAiVoiceStatus,
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
  keyLabel,
  configured,
  onSaveKey,
  onClearKey,
}: {
  kind: OpenAiVoiceEndpointKind;
  label: string;
  keyLabel: string;
  configured: boolean;
  onSaveKey: (apiKey: string) => Promise<void>;
  onClearKey: () => Promise<void>;
}) {
  const { t } = useTranslation("settings");
  const id = useId();
  const keyId = useId();
  const [url, setUrl] = useState("");
  const [savedUrl, setSavedUrl] = useState("");
  const [statusUrl, setStatusUrl] = useState("");
  const [localKeyStatus, setLocalKeyStatus] = useState<{
    url: string;
    configured: boolean;
  } | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getOpenAiVoiceEndpoints().then(
      (settings) => {
        if (active) {
          const value = settings[kind] ?? "";
          setUrl(value);
          setSavedUrl(value);
          setStatusUrl(value);
          setLoaded(true);
        }
      },
      (cause) => {
        if (active) setError(String(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [kind]);

  const changed = url.trim() !== savedUrl;
  const keyConfigured =
    !changed &&
    (localKeyStatus?.url === savedUrl
      ? localKeyStatus.configured
      : statusUrl === savedUrl && configured);

  const save = async () => {
    setSaving(true);
    setError(null);
    let targetUrl = savedUrl;
    let urlSaved = false;
    const savingKey = Boolean(apiKey.trim());
    try {
      // The key command uses the persisted endpoint; commit the displayed URL first.
      if (changed) {
        await setOpenAiVoiceEndpoint(kind, url);
        urlSaved = true;
        targetUrl = (await getOpenAiVoiceEndpoints())[kind] ?? "";
        setUrl(targetUrl);
        setSavedUrl(targetUrl);
        setLocalKeyStatus({ url: targetUrl, configured: false });
      }
      if (savingKey) {
        await onSaveKey(apiKey);
        setApiKey("");
        setLocalKeyStatus({ url: targetUrl, configured: true });
      } else if (changed) {
        // Metadata-only lookup; never request the Keychain secret to render settings.
        const status = await getOpenAiVoiceStatus();
        setLocalKeyStatus({
          url: targetUrl,
          configured: status[`${kind}Configured`],
        });
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(
        urlSaved
          ? t(
              savingKey
                ? "voice.endpointSavedKeyError"
                : "voice.endpointSavedStatusError",
              { error: message },
            )
          : message,
      );
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setSaving(true);
    setError(null);
    try {
      await onClearKey();
      setApiKey("");
      setLocalKeyStatus({ url: savedUrl, configured: false });
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
      <Input
        id={id}
        type="url"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder={DEFAULT_URLS[kind]}
        autoComplete="off"
        spellCheck={false}
      />
      <p className="text-xs text-muted-foreground">
        {t("voice.endpointDefaultHint")}
      </p>
      <label htmlFor={keyId} className="text-xs font-medium">
        {keyLabel}
      </label>
      <Input
        id={keyId}
        type="password"
        value={apiKey}
        onChange={(event) => setApiKey(event.target.value)}
        placeholder={keyConfigured ? "••••••••••••••••••••" : "sk-…"}
        autoComplete="off"
        spellCheck={false}
      />
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => void save()}
          disabled={saving || !loaded || (!changed && !apiKey.trim())}
        >
          {t("voice.saveEndpointSettings")}
        </Button>
        {keyConfigured ? (
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
        {changed
          ? t("voice.endpointUnsavedHint")
          : keyConfigured
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
