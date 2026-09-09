import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { SettingsRow } from "@/shared/ui/settings-row";

export function PlaybackSpeedRow({
  speed,
  speeds,
  onChange,
}: {
  speed: number;
  speeds: readonly number[];
  onChange: (speed: number) => void | Promise<void>;
}) {
  const { t } = useTranslation("settings");
  const options = Array.from(new Set([...speeds, speed])).sort(
    (left, right) => left - right,
  );

  return (
    <SettingsRow
      label={t("voice.playbackSpeed")}
      density="compact"
      action={({ labelId }) => (
        <Select
          value={String(speed)}
          onValueChange={(value) => void onChange(Number(value))}
        >
          <SelectTrigger className="w-24" aria-labelledby={labelId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option} value={String(option)}>
                {option}×
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    />
  );
}
