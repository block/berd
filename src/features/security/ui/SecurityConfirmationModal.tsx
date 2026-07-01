import { ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import {
  allowOptionId,
  blockOptionId,
  SECURITY_ALERT_MARKER,
  useSecurityConfirmationStore,
} from "@/features/security/stores/securityConfirmationStore";

const FINDING_ID_PREFIX = "Finding ID:";

interface ParsedAlert {
  explanation: string;
  findingId: string | null;
}

function parseAlert(alertText: string): ParsedAlert {
  let body = alertText.replace(SECURITY_ALERT_MARKER, "").trim();
  let findingId: string | null = null;

  const findingIndex = body.lastIndexOf(FINDING_ID_PREFIX);
  if (findingIndex !== -1) {
    findingId = body.slice(findingIndex + FINDING_ID_PREFIX.length).trim();
    body = body.slice(0, findingIndex).trim();
  }

  return { explanation: body, findingId };
}

export function SecurityConfirmationModal() {
  const { t } = useTranslation("settings");
  const pending = useSecurityConfirmationStore((state) => state.pending);
  const resolveWith = useSecurityConfirmationStore(
    (state) => state.resolveWith,
  );

  if (!pending) {
    return null;
  }

  const { explanation, findingId } = parseAlert(pending.alertText);

  const handleBlock = () => {
    resolveWith(blockOptionId(pending.request));
  };

  const handleAllow = () => {
    resolveWith(allowOptionId(pending.request));
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Dismissing without an explicit choice defaults to the safe action
        // (block), so a flagged tool call is never silently allowed.
        if (!open) {
          handleBlock();
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-destructive" />
            {t("securityConfirmation.title")}
          </DialogTitle>
          <DialogDescription>
            {t("securityConfirmation.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {explanation && (
            <p className="text-sm text-foreground">{explanation}</p>
          )}

          {pending.command && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">
                {t("securityConfirmation.commandLabel")}
              </p>
              <pre className="max-h-48 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap break-all">
                {pending.command}
              </pre>
            </div>
          )}

          {findingId && (
            <p className="text-xs text-muted-foreground">
              {t("securityConfirmation.findingId", { id: findingId })}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" onClick={handleAllow}>
            {t("securityConfirmation.allow")}
          </Button>
          <Button type="button" variant="destructive" onClick={handleBlock}>
            {t("securityConfirmation.block")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
