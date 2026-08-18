import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

interface UsageDataDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// The "Sharing usage data" details: what telemetry collects and what it never
// collects. One copy of the story, rendered by every surface that asks for
// consent — the onboarding landing page and the Settings privacy row — so the
// two can never drift apart.
export function UsageDataDialog({ open, onOpenChange }: UsageDataDialogProps) {
  const { t } = useTranslation(["settings", "common"]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="xl"
        closeLabel={t("actions.close", { ns: "common" })}
        className="gap-5 rounded-[28px] p-10 pr-12"
        overlayClassName="bg-background/45 [backdrop-filter:blur(14px)_saturate(80%)] [-webkit-backdrop-filter:blur(14px)_saturate(80%)]"
      >
        <DialogHeader>
          <DialogTitle className="text-[20px] font-normal">
            {t("privacy.telemetry.usageDialog.title")}
          </DialogTitle>
        </DialogHeader>
        <DialogDescription className="text-sm leading-[1.35]">
          {t("privacy.telemetry.usageDialog.intro")}
        </DialogDescription>
        <div className="space-y-5 text-sm leading-[1.35]">
          <section>
            <h2 className="font-normal text-foreground">
              {t("privacy.telemetry.usageDialog.collectTitle")}
            </h2>
            <p className="mt-1 text-muted-foreground">
              {t("privacy.telemetry.usageDialog.collectBody")}
            </p>
          </section>
          <section>
            <h2 className="font-normal text-foreground">
              {t("privacy.telemetry.usageDialog.notCollectTitle")}
            </h2>
            <p className="mt-1 text-muted-foreground">
              {t("privacy.telemetry.usageDialog.notCollectBody")}
            </p>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
