import { toast } from "sonner";
import { ToastActionButton, ToastActionGroup } from "@/shared/ui/sonner";

export type CompletionNotificationOutcome = "completed" | "error" | "stopped";

const TOAST_DURATION_MS = 8000;

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
}: {
  title: string;
  outcome: CompletionNotificationOutcome;
  onView: () => void;
  onChangeSound?: () => void;
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

  const action = onChangeSound ? (
    <ToastActionGroup>
      <ToastActionButton
        className="ml-0"
        emphasis="secondary"
        onClick={handleChangeSound}
      >
        Change sound
      </ToastActionButton>
      <ToastActionButton className="ml-0" onClick={handleView}>
        View
      </ToastActionButton>
    </ToastActionGroup>
  ) : (
    <ToastActionButton onClick={handleView}>View</ToastActionButton>
  );

  const options = {
    action,
    description: getCompletionToastDescription(outcome),
    duration: TOAST_DURATION_MS,
  };

  if (outcome === "error") {
    toastId = toast.error(title, options);
    return;
  }

  toastId = toast(title, options);
}
