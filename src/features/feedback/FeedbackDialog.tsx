import { useCallback, useEffect, useRef, useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type DoctorReport, runDoctor } from "@/shared/api/doctor";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { Textarea } from "@/shared/ui/textarea";
import type { FeedbackDraft } from "./feedbackDialogStore";
import { getFeedbackSubmitErrorMessage } from "./feedbackErrors";
import { submitFeedbackReport } from "./submitFeedbackReport";
import { useFeedbackImageAttachments } from "./useFeedbackImageAttachments";

interface FeedbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft?: FeedbackDraft | null;
}

const FEEDBACK_FORM_ID = "feedback-form";

interface SuccessState {
  issueUrl?: string;
}

export function FeedbackDialog({
  open,
  onOpenChange,
  draft,
}: FeedbackDialogProps) {
  const { t } = useTranslation("feedback");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [includeLogs, setIncludeLogs] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<SuccessState | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  // The doctor check is kicked off as soon as the form is shown so its output
  // is ready to fold into the diagnostic zip; submission awaits this promise
  // before attaching logs. Resolves to null if the check fails — a failed
  // health check should never block a feedback report.
  const doctorReportRef = useRef<Promise<DoctorReport | null> | null>(null);
  const {
    attachments,
    attachmentFiles,
    attachmentPaths,
    canAddImages,
    clearAttachments,
    handleAddImages,
    handlePasteImages,
    removeAttachment,
  } = useFeedbackImageAttachments({
    disabled: submitting,
    setError,
  });

  const trimmedTitle = title.trim();
  const trimmedDescription = description.trim();
  const canSubmit =
    trimmedTitle.length > 0 && trimmedDescription.length > 0 && !submitting;
  const isDirty =
    success === null &&
    (trimmedTitle.length > 0 ||
      trimmedDescription.length > 0 ||
      attachments.length > 0);

  const startDoctorCheck = useCallback(() => {
    doctorReportRef.current = runDoctor().catch((doctorError) => {
      console.warn("feedback: doctor check failed", doctorError);
      return null;
    });
  }, []);
  const [previousOpen, setPreviousOpen] = useState(open);
  if (previousOpen !== open) {
    setPreviousOpen(open);
    if (!open) {
      doctorReportRef.current = null;
      setTitle("");
      setDescription("");
      clearAttachments();
      setIncludeLogs(false);
      setError(null);
      setSubmitting(false);
      setSuccess(null);
      setDiscardOpen(false);
    }
  }

  function resetForm() {
    setTitle("");
    setDescription("");
    clearAttachments();
    setIncludeLogs(false);
    setError(null);
    setSubmitting(false);
    setSuccess(null);
    startDoctorCheck();
  }

  useEffect(() => {
    if (open) {
      setTitle(draft?.title ?? "");
      setDescription(draft?.description ?? "");
      setIncludeLogs(draft?.includeLogs ?? false);
      setError(null);
      setSuccess(null);
      startDoctorCheck();
    }
  }, [draft, open, startDoctorCheck]);

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
      const result = await submitFeedbackReport({
        title: trimmedTitle,
        description: trimmedDescription,
        attachmentPaths,
        attachmentFiles,
        includeLogs,
        doctorReportPromise: doctorReportRef.current,
        titleSuffix: draft?.titleSuffix,
        metadata: draft?.metadata,
        labelIds: draft?.labelIds,
      });
      clearAttachments();
      setSuccess({ issueUrl: result.issueUrl });
    } catch (submitError) {
      const message = getFeedbackSubmitErrorMessage(submitError, t);
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
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            handleClose();
            return;
          }
          onOpenChange(true);
        }}
      >
        <DialogContent size="md">
          <DialogHeader className="py-3.5">
            <DialogTitle>{t("dialog.title")}</DialogTitle>
            <DialogDescription>{t("dialog.description")}</DialogDescription>
          </DialogHeader>
          {success ? (
            <>
              <DialogBody>
                <div className="space-y-2 py-2">
                  <p className="text-sm font-medium text-foreground">
                    {t("dialog.successTitle")}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {t("dialog.successBody")}
                  </p>
                </div>
              </DialogBody>
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleSubmitAnother}
                >
                  {t("dialog.submitAnother")}
                </Button>
                {success.issueUrl ? (
                  <Button type="button" onClick={handleViewTicket}>
                    {t("dialog.viewTicket")}
                  </Button>
                ) : null}
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogBody asChild className="space-y-3 pb-4">
                <form
                  id={FEEDBACK_FORM_ID}
                  onSubmit={(event) => {
                    void handleSubmit(event);
                  }}
                  onPaste={handlePasteImages}
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
                      className="h-8 rounded-md"
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
                      rows={3}
                      disabled={submitting}
                      className="min-h-[72px] rounded-md py-2"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs font-medium text-muted-foreground">
                      {t("dialog.attachmentsLabel")}
                    </Label>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-auto w-full justify-start gap-2 rounded-md px-3 py-2 text-left"
                      onClick={handleAddImages}
                      disabled={!canAddImages}
                    >
                      <span className="flex size-6 shrink-0 items-center justify-center rounded border border-border bg-background">
                        <ImagePlus className="size-3.5" aria-hidden="true" />
                      </span>
                      <span className="flex min-w-0 flex-col items-start gap-0.5">
                        <span className="text-xs font-medium text-foreground">
                          {t("dialog.addImages")}
                        </span>
                        <span className="text-[11px] font-normal leading-snug text-muted-foreground">
                          {t("dialog.attachmentsHelp")}
                        </span>
                      </span>
                    </Button>
                    {attachments.length > 0 ? (
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {attachments.map((attachment) => (
                          <div
                            key={attachment.id}
                            className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/20 p-2"
                          >
                            <img
                              src={attachment.previewUrl}
                              alt=""
                              className="size-9 shrink-0 rounded object-cover"
                            />
                            <span
                              className="min-w-0 flex-1 truncate text-xs text-foreground"
                              title={attachment.name}
                            >
                              {attachment.name}
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => removeAttachment(attachment.id)}
                              disabled={submitting}
                              aria-label={t("dialog.removeAttachment", {
                                name: attachment.name,
                              })}
                            >
                              <X className="size-3.5" aria-hidden="true" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex items-start gap-2 rounded-md border border-input bg-background px-3 py-2">
                    <Checkbox
                      id="feedback-include-logs"
                      checked={includeLogs}
                      onCheckedChange={(checked) => {
                        setIncludeLogs(checked === true);
                        setError(null);
                      }}
                      disabled={submitting}
                      className="mt-0.5"
                    />
                    <div className="min-w-0">
                      <Label
                        htmlFor="feedback-include-logs"
                        className="text-xs font-medium text-foreground"
                      >
                        {t("dialog.attachLogs")}
                      </Label>
                      <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                        {t("dialog.attachLogsHelp")}
                      </p>
                    </div>
                  </div>
                  {error ? (
                    <p
                      role="alert"
                      className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                    >
                      {error}
                    </p>
                  ) : null}
                </form>
              </DialogBody>
              <DialogFooter className="py-3">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleClose}
                  disabled={submitting}
                >
                  {t("dialog.discardCancel")}
                </Button>
                <Button
                  type="submit"
                  form={FEEDBACK_FORM_ID}
                  disabled={!canSubmit}
                  feedbackState={submitting ? "loading" : "idle"}
                  loadingLabel={t("dialog.submitting")}
                >
                  {t("dialog.submit")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
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
