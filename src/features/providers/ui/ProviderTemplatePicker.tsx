import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { SearchBar } from "@/shared/ui/SearchBar";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { EdgeFade } from "@/shared/ui/EdgeFade";
import { RowButton } from "@/shared/ui/row-button";
import type { ProviderTemplate } from "./CustomProviderForm";

interface ProviderTemplatePickerProps {
  templates: ProviderTemplate[];
  onSelect: (templateId: string) => void;
  /** Start a blank, fully-custom provider instead of picking a template. */
  onStartManual?: () => void;
  disabled?: boolean;
}

function matchesTemplateSearch(template: ProviderTemplate, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }

  return [
    template.displayName,
    template.description ?? "",
    template.engine,
    template.id,
    ...template.models,
  ]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

export function ProviderTemplatePicker({
  templates,
  onSelect,
  onStartManual,
  disabled = false,
}: ProviderTemplatePickerProps) {
  const { t } = useTranslation("settings");
  const [query, setQuery] = useState("");
  const filteredTemplates = useMemo(
    () => templates.filter((t) => matchesTemplateSearch(t, query)),
    [query, templates],
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
            {filteredTemplates.map((template) => (
              <RowButton
                key={template.id}
                variant="menu"
                onClick={() => onSelect(template.id)}
                disabled={disabled}
                label={template.displayName}
                description={
                  template.models.length > 0
                    ? t("providers.custom.modelCount", {
                        count: template.models.length,
                      })
                    : undefined
                }
              />
            ))}

            {filteredTemplates.length === 0 ? (
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
