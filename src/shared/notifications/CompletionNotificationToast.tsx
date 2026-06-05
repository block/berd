import { toast } from "sonner";
import { ToastActionButton } from "@/shared/ui/sonner";

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
}: {
  title: string;
  outcome: CompletionNotificationOutcome;
  onView: () => void;
}): void {
  let toastId: string | number | undefined;
  const handleView = () => {
    if (toastId !== undefined) {
      toast.dismiss(toastId);
    }
    onView();
  };

  const options = {
    action: <ToastActionButton onClick={handleView}>View</ToastActionButton>,
    description: getCompletionToastDescription(outcome),
    duration: TOAST_DURATION_MS,
  };

  if (outcome === "error") {
    toastId = toast.error(title, options);
    return;
  }

  toastId = toast(title, options);
}
