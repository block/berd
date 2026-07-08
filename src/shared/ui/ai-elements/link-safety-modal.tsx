import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Label } from "@/shared/ui/label";
import { extractDomain, trustDomain } from "@/shared/lib/trustedDomains";

interface LinkSafetyModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenLink?: (url: string) => Promise<void>;
  url: string;
}

export function LinkSafetyModal({
  isOpen,
  onClose,
  onOpenLink,
  url,
}: LinkSafetyModalProps) {
  const { t } = useTranslation("common");
  const [isCopied, setIsCopied] = useState(false);
  const [trustChecked, setTrustChecked] = useState(false);
  const timeoutRef = useRef<number>(0);

  const domain = useMemo(() => extractDomain(url), [url]);

  if (isOpen && isCopied) {
    setIsCopied(false);
  }

  useEffect(
    () => () => {
      window.clearTimeout(timeoutRef.current);
    },
    [],
  );

  // Reset the checkbox when the modal opens with a new URL
  useEffect(() => {
    if (isOpen) {
      setTrustChecked(false);
    }
  }, [isOpen, url]);

  const handleOpen = useCallback(async () => {
    try {
      await (onOpenLink ?? openUrl)(url);
      if (trustChecked && domain) {
        trustDomain(domain);
      }
    } catch (e: unknown) {
      console.error("[linkSafety] openUrl failed:", e);
    }
    onClose();
  }, [url, onClose, onOpenLink, trustChecked, domain]);

  const handleCopy = useCallback(() => {
    if (isCopied) return;
    navigator.clipboard
      .writeText(url)
      .then(() => {
        setIsCopied(true);
        timeoutRef.current = window.setTimeout(() => setIsCopied(false), 2000);
      })
      .catch((e: unknown) =>
        console.error("[linkSafety] clipboard write failed:", e),
      );
  }, [url, isCopied]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) onClose();
    },
    [onClose],
  );

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("components.linkSafety.title")}</DialogTitle>
          <DialogDescription>
            {t("components.linkSafety.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="break-all font-mono text-sm text-muted-foreground">
          {url}
        </div>
        {domain && (
          <Label className="cursor-pointer items-center text-muted-foreground">
            <Checkbox
              className="border-current"
              checked={trustChecked}
              onCheckedChange={(checked) => setTrustChecked(checked === true)}
            />
            {t("components.linkSafety.dontAskAgain", { domain })}
          </Label>
        )}
        <DialogFooter className="flex-row">
          <Button
            className="flex-1"
            onClick={handleCopy}
            type="button"
            variant="outline"
          >
            {isCopied
              ? t("components.linkSafety.copied")
              : t("components.linkSafety.copyLink")}
          </Button>
          <Button className="flex-1" onClick={handleOpen} type="button">
            {t("components.linkSafety.openLink")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
