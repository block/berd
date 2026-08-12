import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";

interface ProviderSetupRequiredProps {
  onOpenProviders: () => void;
}

export function ProviderSetupRequired({
  onOpenProviders,
}: ProviderSetupRequiredProps) {
  const { t } = useTranslation("settings");

  return (
    <div className="flex flex-col items-center gap-4 rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
      <div className="space-y-2">
        <h2 className="text-xl font-semibold text-foreground">
          {t("providers.setupRequired.title")}
        </h2>
        <p className="max-w-[420px] text-sm text-muted-foreground">
          {t("providers.setupRequired.body")}
        </p>
      </div>
      <Button type="button" onClick={onOpenProviders}>
        {t("providers.setupRequired.openProviders")}
      </Button>
    </div>
  );
}
