import { useId } from "react";
import { useTranslation } from "react-i18next";
import { RadioGroup, RadioGroupItem } from "@/shared/ui/radio-group";
import { VoicePickerDialog } from "./VoicePickerDialog";

export interface SimpleVoiceOption {
  value: string;
  label: string;
}

export function SimpleVoicePickerDialog({
  options,
  selectedVoice,
  defaultVoice,
  error,
  onChange,
}: {
  options: readonly SimpleVoiceOption[];
  selectedVoice: string;
  defaultVoice?: string;
  error?: string | null;
  onChange: (voice: string) => void | Promise<void>;
}) {
  const { t } = useTranslation("settings");
  const optionIdPrefix = useId();
  const rawSelectedLabel =
    options.find((option) => option.value === selectedVoice)?.label ??
    selectedVoice;
  const selectedLabel =
    selectedVoice === defaultVoice
      ? t("voice.defaultOption", { value: rawSelectedLabel })
      : rawSelectedLabel;

  return (
    <VoicePickerDialog selectedVoice={selectedLabel} dialogError={error}>
      <RadioGroup
        value={selectedVoice}
        onValueChange={(voice) => void onChange(voice)}
        className="divide-y divide-border rounded-md border border-border"
        aria-label={t("voice.voice")}
      >
        {options.map((option) => (
          <label
            key={option.value}
            htmlFor={`${optionIdPrefix}-${option.value}`}
            data-voice-selected={option.value === selectedVoice || undefined}
            className="flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2 text-sm"
          >
            <RadioGroupItem
              id={`${optionIdPrefix}-${option.value}`}
              value={option.value}
            />
            <span>
              {option.value === defaultVoice
                ? t("voice.defaultOption", { value: option.label })
                : option.label}
            </span>
          </label>
        ))}
      </RadioGroup>
    </VoicePickerDialog>
  );
}
