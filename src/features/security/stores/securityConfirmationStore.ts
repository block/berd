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

interface SecurityConfirmationState {
  pending: PendingSecurityConfirmation | null;
  enqueue: (pending: PendingSecurityConfirmation) => void;
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

    enqueue: (pending) => {
      set({ pending });
    },

    resolveWith: (selectedOptionId) => {
      const { pending } = get();
      if (!pending) {
        return;
      }
      pending.resolve({
        outcome: { outcome: "selected", optionId: selectedOptionId },
      });
      set({ pending: null });
    },

    cancel: () => {
      const { pending } = get();
      if (!pending) {
        return;
      }
      pending.resolve({ outcome: { outcome: "cancelled" } });
      set({ pending: null });
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
