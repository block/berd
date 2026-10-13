import { toast } from "sonner";
import { ToastActionButton, ToastActionGroup } from "@/shared/ui/sonner";
import {
  DEFAULT_TOAST_DURATION_SECONDS,
  NEVER_DISMISS_TOAST_DURATION_SECONDS,
  toastDurationSecondsToMs,
} from "@/shared/notifications/toastDuration";

export type CompletionNotificationOutcome = "completed" | "error" | "stopped";

export function getCompletionToastDescription(
  outcome: CompletionNotificationOutcome,
): string {
  if (outcome === "error") return "Agent response needs attention";
  if (outcome === "stopped") return "Agent response stopped";
  return "Agent response complete";
}

export function showCompletionNotificationToast({
  title,
  outcome,
  onView,
  onChangeSound,
  durationSeconds = DEFAULT_TOAST_DURATION_SECONDS,
  dismissLabel = "Dismiss",
}: {
  title: string;
  outcome: CompletionNotificationOutcome;
  onView: () => void;
  onChangeSound?: () => void;
  durationSeconds?: number;
  /** Localized label for the explicit dismiss action on persistent toasts. */
  dismissLabel?: string;
}): void {
  let toastId: string | number | undefined;
  const handleView = () => {
    if (toastId !== undefined) {
      toast.dismiss(toastId);
    }
    onView();
  };
  const handleChangeSound = () => {
    if (toastId !== undefined) {
      toast.dismiss(toastId);
    }
    onChangeSound?.();
  };

  // Persistent (never-dismiss) toasts stay on screen until the user acts, so
  // they need an explicit dismissal that neither navigates nor opens settings.
  const isPersistent = durationSeconds === NEVER_DISMISS_TOAST_DURATION_SECONDS;
  const handleDismiss = () => {
    if (toastId !== undefined) {
      toast.dismiss(toastId);
    }
  };

  const secondaryActions = [
    isPersistent ? (
      <ToastActionButton
        key="dismiss"
        className="ml-0"
        emphasis="secondary"
        onClick={handleDismiss}
      >
        {dismissLabel}
      </ToastActionButton>
    ) : null,
    onChangeSound ? (
      <ToastActionButton
        key="change-sound"
        className="ml-0"
        emphasis="secondary"
        onClick={handleChangeSound}
      >
        Change sound
      </ToastActionButton>
    ) : null,
  ].filter((element) => element !== null);

  const action =
    secondaryActions.length > 0 ? (
      <ToastActionGroup>
        {...secondaryActions}
        <ToastActionButton key="view" className="ml-0" onClick={handleView}>
          View
        </ToastActionButton>
      </ToastActionGroup>
    ) : (
      <ToastActionButton onClick={handleView}>View</ToastActionButton>
    );

  const options = {
    action,
    description: getCompletionToastDescription(outcome),
    duration: toastDurationSecondsToMs(durationSeconds),
  };

  if (outcome === "error") {
    toastId = toast.error(title, options);
    return;
  }

  toastId = toast(title, options);
}
