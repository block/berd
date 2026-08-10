import { useTranslation } from "react-i18next";
import {
  AUTO_ARCHIVE_OPTIONS,
  type AutoArchiveAfter,
  useAutoArchivePreference,
} from "@/features/settings/lib/autoArchivePreference";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { SettingsRow } from "@/shared/ui/settings-row";
import { SettingsSection } from "@/shared/ui/settings-section";

export function AutoArchiveChatsSection() {
  const { t } = useTranslation("settings");
  const { value, setValue } = useAutoArchivePreference();

  return (
    <SettingsSection title={t("archive.autoArchive.sectionTitle")}>
      <SettingsRow
        label={t("archive.autoArchive.label")}
        description={t("archive.autoArchive.description")}
        action={({ labelId, descriptionId }) => (
          <Select
            value={value}
            onValueChange={(nextValue) =>
              setValue(nextValue as AutoArchiveAfter)
            }
          >
            <SelectTrigger
              className="w-40"
              aria-labelledby={labelId}
              aria-describedby={descriptionId}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AUTO_ARCHIVE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {t(`archive.autoArchive.options.${option.value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      />
    </SettingsSection>
  );
}
