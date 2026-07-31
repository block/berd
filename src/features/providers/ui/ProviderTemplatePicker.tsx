import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  searchProviderChoices,
  type ProviderDirectoryChoice,
} from "@/features/providers/lib/providerDirectory";
import { SearchBar } from "@/shared/ui/SearchBar";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { EdgeFade } from "@/shared/ui/EdgeFade";
import { RowButton } from "@/shared/ui/row-button";
import { Spinner } from "@/shared/ui/spinner";

interface ProviderTemplatePickerProps {
  choices: ProviderDirectoryChoice[];
  onSelect: (choice: ProviderDirectoryChoice) => void;
  /** Start a blank, fully-custom provider instead of picking a known provider. */
  onStartManual?: () => void;
  disabled?: boolean;
  loading?: boolean;
}

export function ProviderTemplatePicker({
  choices,
  onSelect,
  onStartManual,
  disabled = false,
  loading = false,
}: ProviderTemplatePickerProps) {
  const { t } = useTranslation("settings");
  const [query, setQuery] = useState("");
  const filteredChoices = useMemo(
    () => searchProviderChoices(choices, query),
    [choices, query],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SearchBar
        value={query}
        onChange={setQuery}
        placeholder={t("providers.custom.templates.searchPlaceholder")}
        size="small"
        className="shrink-0"
        aria-label={t("providers.custom.templates.searchPlaceholder")}
      />

      <div className="relative mt-3 min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="space-y-0.5 pr-1 pt-2">
            {filteredChoices.map((choice) => (
              <RowButton
                key={`${choice.kind}:${choice.id}`}
                variant="menu"
                onClick={() => onSelect(choice)}
                disabled={disabled}
                label={choice.displayName}
                description={
                  choice.kind === "template" &&
                  choice.template.models.length > 0
                    ? t("providers.custom.modelCount", {
                        count: choice.template.models.length,
                      })
                    : choice.description
                }
              />
            ))}

            {loading ? (
              <div className="flex items-center justify-center gap-2 px-2 py-6 text-xs text-muted-foreground">
                <Spinner className="size-3" />
                {t("providers.custom.templates.loading")}
              </div>
            ) : filteredChoices.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                {t("providers.custom.templates.empty")}
              </p>
            ) : null}
          </div>
        </ScrollArea>
        <EdgeFade
          direction="top"
          className="top-0 h-10"
          surface="color-mix(in oklab, var(--background) 88%, transparent)"
        />
      </div>

      {onStartManual ? (
        <div className="shrink-0 border-t border-border/80 pt-6">
          <div className="space-y-1.5">
            <p className="px-0.5 text-xs text-muted-foreground">
              {t("providers.custom.templates.manualLead")}
            </p>
            <RowButton
              variant="field"
              onClick={onStartManual}
              disabled={disabled}
              label={t("providers.custom.templates.manual")}
              description={t("providers.custom.templates.manualDescription")}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
