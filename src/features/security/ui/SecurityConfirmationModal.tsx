import { Loader2, ShieldAlert, TriangleAlert } from "lucide-react";
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
  useSecurityConfirmationStore,
} from "@/features/security/stores/securityConfirmationStore";
import {
  extractConfidence,
  meaningfulAlertExplanation,
} from "@/features/security/lib/inferExplanation";
import { requestOpenSettings } from "@/features/settings/lib/settingsEvents";

const FINDING_ID_PREFIX = "Finding ID:";

interface ParsedAlert {
  explanation: string;
  confidence: number | null;
  findingId: string | null;
}

function parseAlert(alertText: string): ParsedAlert {
  let findingId: string | null = null;

  const findingIndex = alertText.lastIndexOf(FINDING_ID_PREFIX);
  if (findingIndex !== -1) {
    findingId = alertText.slice(findingIndex + FINDING_ID_PREFIX.length).trim();
  }

  const confidence = extractConfidence(alertText);
  const explanation = meaningfulAlertExplanation(alertText);

  return { explanation, confidence, findingId };
}

export function SecurityConfirmationModal() {
  const { t } = useTranslation("settings");
  const pending = useSecurityConfirmationStore((state) => state.pending);
  const inferredExplanation = useSecurityConfirmationStore(
    (state) => state.inferredExplanation,
  );
  const resolveWith = useSecurityConfirmationStore(
    (state) => state.resolveWith,
  );

  if (!pending) {
    return null;
  }

  const { explanation, confidence, findingId } = parseAlert(pending.alertText);

  const handleBlock = () => {
    resolveWith(blockOptionId(pending.request));
  };

  const handleAllow = () => {
    resolveWith(allowOptionId(pending.request));
  };

  const handleConnectGoose = () => {
    // Provider settings cannot be used while this blocking permission dialog is
    // open, so safely block the current tool call before opening setup.
    handleBlock();
    requestOpenSettings("providers");
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
      <DialogContent size="xl" className="min-w-0 overflow-x-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-destructive" />
            {t("securityConfirmation.title")}
          </DialogTitle>
          <DialogDescription>
            {t("securityConfirmation.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-3">
          {/* Detection confidence badge */}
          {confidence != null && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                {t("securityConfirmation.detectionConfidence")}
              </span>
              <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-semibold text-destructive">
                {Math.round(confidence * 100)}%
              </span>
            </div>
          )}

          {/* Original explanation from pattern-based detector (if present) */}
          {explanation && (
            <p className="break-words text-sm text-foreground">{explanation}</p>
          )}

          {/* Inferred explanation for ML-only detections */}
          {inferredExplanation.status === "loading" && (
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 p-3">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="text-xs text-muted-foreground">
                {t("securityConfirmation.inferring")}
              </span>
            </div>
          )}

          {inferredExplanation.status === "done" && (
            <div className="space-y-1.5 rounded-md border border-border bg-muted/50 p-3">
              <div className="flex items-center gap-1.5">
                <TriangleAlert className="h-3.5 w-3.5 text-warning" />
                <span className="text-xs font-medium text-muted-foreground">
                  {t("securityConfirmation.inferredLabel")}
                </span>
              </div>
              <p className="break-words text-sm text-foreground">
                {inferredExplanation.text}
              </p>
            </div>
          )}

          {inferredExplanation.status === "failed" && (
            <div className="flex items-start gap-2 rounded-md border border-border bg-muted/50 p-3">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              <p className="text-xs text-muted-foreground">
                {t("securityConfirmation.inferenceFailed")}
              </p>
            </div>
          )}

          {inferredExplanation.status === "needs_setup" && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/50 p-3">
              <div className="flex min-w-0 items-start gap-2">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                <p className="text-xs text-muted-foreground">
                  {t("securityConfirmation.connectGooseDescription")}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleConnectGoose}
              >
                {t("securityConfirmation.connectGoose")}
              </Button>
            </div>
          )}

          {/* Flagged command */}
          {pending.command && (
            <div className="min-w-0 space-y-1">
              <p className="text-xs font-medium text-muted-foreground">
                {t("securityConfirmation.commandLabel")}
              </p>
              <pre className="max-h-48 max-w-full overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap break-all">
                {pending.command}
              </pre>
            </div>
          )}

          {findingId && (
            <p className="break-all text-xs text-muted-foreground">
              {t("securityConfirmation.findingId", { id: findingId })}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" onClick={handleAllow}>
            {t("securityConfirmation.allow")}
          </Button>
          <Button
            type="button"
            variant="primary"
            destructive
            onClick={handleBlock}
          >
            {t("securityConfirmation.block")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
