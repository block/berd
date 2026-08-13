import { useState } from "react";
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
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { SettingsRow } from "@/shared/ui/settings-row";
import { SettingsSection } from "@/shared/ui/settings-section";

export function AutoArchiveChatsSection() {
  const { t } = useTranslation(["settings", "common"]);
  const { value, setValue } = useAutoArchivePreference();
  const [pendingValue, setPendingValue] = useState<AutoArchiveAfter | null>(
    null,
  );

  function selectValue(nextValue: AutoArchiveAfter) {
    if (nextValue === "never") {
      setValue(nextValue);
      return;
    }
    setPendingValue(nextValue);
  }

  return (
    <>
      <SettingsSection title={t("archive.autoArchive.sectionTitle")}>
        <SettingsRow
          label={t("archive.autoArchive.label")}
          description={t("archive.autoArchive.description")}
          action={({ labelId, descriptionId }) => (
            <Select
              value={value}
              onValueChange={(nextValue) =>
                selectValue(nextValue as AutoArchiveAfter)
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

      <ConfirmDialog
        open={pendingValue !== null}
        onOpenChange={(open) => !open && setPendingValue(null)}
        title={t("archive.autoArchive.confirmTitle")}
        description={t("archive.autoArchive.confirmDescription", {
          duration: pendingValue
            ? t(`archive.autoArchive.options.${pendingValue}`).toLowerCase()
            : "",
        })}
        cancelLabel={t("common:actions.cancel")}
        confirmLabel={t("archive.autoArchive.confirmAction")}
        destructive={false}
        onConfirm={() => {
          if (pendingValue) setValue(pendingValue);
          setPendingValue(null);
        }}
      />
    </>
  );
}
