import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  FeedbackSubmissionError,
  submitFeedbackIssue,
} from "@/shared/api/feedback";
import { getPlatform } from "@/shared/lib/platform";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import {
  EditDialog,
  EditDialogBody,
  EditDialogContent,
  EditDialogFooter,
  EditDialogForm,
  EditDialogHeader,
} from "@/shared/ui/EditDialog";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { Textarea } from "@/shared/ui/textarea";

interface FeedbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const FEEDBACK_FORM_ID = "feedback-form";

interface SuccessState {
  issueUrl?: string;
}

function buildEnhancedDescription(
  description: string,
  version: string,
  platform: string,
): string {
  return [
    description,
    "",
    "---",
    `App version: ${version}`,
    `Platform: ${platform}`,
  ].join("\n");
}

export function FeedbackDialog({ open, onOpenChange }: FeedbackDialogProps) {
  const { t } = useTranslation("feedback");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<SuccessState | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);

  const trimmedTitle = title.trim();
  const trimmedDescription = description.trim();
  const canSubmit =
    trimmedTitle.length > 0 && trimmedDescription.length > 0 && !submitting;
  const isDirty =
    success === null &&
    (trimmedTitle.length > 0 || trimmedDescription.length > 0);

  function resetForm() {
    setTitle("");
    setDescription("");
    setError(null);
    setSubmitting(false);
    setSuccess(null);
  }

  useEffect(() => {
    if (open) {
      return;
    }
    setTitle("");
    setDescription("");
    setError(null);
    setSubmitting(false);
    setSuccess(null);
    setDiscardOpen(false);
  }, [open]);

  const handleClose = () => {
    if (submitting) {
      return;
    }
    if (isDirty) {
      setDiscardOpen(true);
      return;
    }
    onOpenChange(false);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      let version: string;
      try {
        version = await getVersion();
      } catch {
        version = "unknown";
      }
      const platform = getPlatform();
      const enhancedDescription = buildEnhancedDescription(
        trimmedDescription,
        version,
        platform,
      );
      const result = await submitFeedbackIssue({
        title: trimmedTitle,
        description: enhancedDescription,
      });
      setSuccess({ issueUrl: result.issueUrl });
    } catch (submitError) {
      const message = getSubmitErrorMessage(submitError, t);
      setError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleViewTicket = () => {
    if (!success?.issueUrl) {
      return;
    }
    void openUrl(success.issueUrl).catch((openError) => {
      const message =
        openError instanceof Error
          ? openError.message
          : String(openError ?? "");
      toast.error(message || t("dialog.submitError"));
    });
  };

  const handleSubmitAnother = () => {
    resetForm();
  };

  return (
    <>
      <EditDialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            handleClose();
            return;
          }
          onOpenChange(true);
        }}
      >
        <EditDialogContent size="lg">
          <EditDialogHeader
            title={t("dialog.title")}
            description={t("dialog.description")}
          />
          {success ? (
            <>
              <EditDialogBody>
                <div className="space-y-2 py-2">
                  <p className="text-sm font-medium text-foreground">
                    {t("dialog.successTitle")}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {t("dialog.successBody")}
                  </p>
                </div>
              </EditDialogBody>
              <EditDialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleSubmitAnother}
                >
                  {t("dialog.submitAnother")}
                </Button>
                {success.issueUrl ? (
                  <Button type="button" size="sm" onClick={handleViewTicket}>
                    {t("dialog.viewTicket")}
                  </Button>
                ) : null}
              </EditDialogFooter>
            </>
          ) : (
            <>
              <EditDialogForm
                id={FEEDBACK_FORM_ID}
                onSubmit={(event) => {
                  void handleSubmit(event);
                }}
              >
                <div className="space-y-1.5">
                  <Label
                    htmlFor="feedback-title"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {t("dialog.titleLabel")}
                  </Label>
                  <Input
                    id="feedback-title"
                    autoFocus
                    value={title}
                    onChange={(event) => {
                      setTitle(event.target.value);
                      setError(null);
                    }}
                    placeholder={t("dialog.titlePlaceholder")}
                    disabled={submitting}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label
                    htmlFor="feedback-description"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {t("dialog.descriptionLabel")}
                  </Label>
                  <Textarea
                    id="feedback-description"
                    value={description}
                    onChange={(event) => {
                      setDescription(event.target.value);
                      setError(null);
                    }}
                    placeholder={t("dialog.descriptionPlaceholder")}
                    rows={6}
                    disabled={submitting}
                  />
                </div>
                {error ? (
                  <p
                    role="alert"
                    className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                  >
                    {error}
                  </p>
                ) : null}
              </EditDialogForm>
              <EditDialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleClose}
                  disabled={submitting}
                >
                  {t("dialog.discardCancel")}
                </Button>
                <Button
                  type="submit"
                  form={FEEDBACK_FORM_ID}
                  size="sm"
                  disabled={!canSubmit}
                  feedbackState={submitting ? "loading" : "idle"}
                  loadingLabel={t("dialog.submitting")}
                >
                  {t("dialog.submit")}
                </Button>
              </EditDialogFooter>
            </>
          )}
        </EditDialogContent>
      </EditDialog>
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title={t("dialog.discardTitle")}
        description={t("dialog.discardBody")}
        cancelLabel={t("dialog.discardCancel")}
        confirmLabel={t("dialog.discardConfirm")}
        overlayClassName="z-[70]"
        positionerClassName="z-[71]"
        onConfirm={() => {
          setDiscardOpen(false);
          onOpenChange(false);
        }}
      />
    </>
  );
}

function getSubmitErrorMessage(
  error: unknown,
  t: (key: string) => string,
): string {
  if (
    error instanceof FeedbackSubmissionError &&
    error.code === "networkAccess"
  ) {
    return t("dialog.networkAccessError");
  }
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return t("dialog.submitError");
}
