import { create } from "zustand";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

export const SECURITY_ALERT_MARKER = "🔒 Security Alert";

export interface PendingSecurityConfirmation {
  request: RequestPermissionRequest;
  title: string;
  command: string | null;
  alertText: string;
  resolve: (response: RequestPermissionResponse) => void;
}

export type InferredExplanationState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; text: string }
  | { status: "needs_setup" }
  | { status: "failed" };

interface SecurityConfirmationState {
  pending: PendingSecurityConfirmation | null;
  inferredExplanation: InferredExplanationState;
  enqueue: (pending: PendingSecurityConfirmation) => void;
  setInferredExplanation: (state: InferredExplanationState) => void;
  resolveWith: (optionId: string) => void;
  cancel: () => void;
}

function optionId(
  request: RequestPermissionRequest,
  kind: string,
  fallbackIndex: number,
): string {
  const match = request.options?.find((option) => option.kind === kind);
  return match?.optionId ?? request.options?.[fallbackIndex]?.optionId ?? kind;
}

export const useSecurityConfirmationStore = create<SecurityConfirmationState>(
  (set, get) => ({
    pending: null,
    inferredExplanation: { status: "idle" },

    enqueue: (pending) => {
      set({ pending, inferredExplanation: { status: "idle" } });
    },

    setInferredExplanation: (inferredExplanation) => {
      set({ inferredExplanation });
    },

    resolveWith: (selectedOptionId) => {
      const { pending } = get();
      if (!pending) {
        return;
      }
      pending.resolve({
        outcome: { outcome: "selected", optionId: selectedOptionId },
      });
      set({ pending: null, inferredExplanation: { status: "idle" } });
    },

    cancel: () => {
      const { pending } = get();
      if (!pending) {
        return;
      }
      pending.resolve({ outcome: { outcome: "cancelled" } });
      set({ pending: null, inferredExplanation: { status: "idle" } });
    },
  }),
);

/** Resolve the "block this tool call" option id for the current request. */
export function blockOptionId(request: RequestPermissionRequest): string {
  return optionId(request, "reject_once", 2);
}

/** Resolve the "allow this tool call once" option id for the current request. */
export function allowOptionId(request: RequestPermissionRequest): string {
  return optionId(request, "allow_once", 1);
}
