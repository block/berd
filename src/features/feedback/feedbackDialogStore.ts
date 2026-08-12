import { create } from "zustand";

export interface FeedbackDraft {
  title: string;
  description: string;
  includeLogs: boolean;
  titleSuffix?: string;
  metadata?: Record<string, string>;
  labelIds?: string[];
}

interface FeedbackDialogState {
  open: boolean;
  draft: FeedbackDraft | null;
  openDialog: (draft?: FeedbackDraft) => boolean;
  setOpen: (open: boolean) => void;
}

export const useFeedbackDialogStore = create<FeedbackDialogState>((set) => ({
  open: false,
  draft: null,
  openDialog: (draft) => {
    let opened = false;
    set((state) => {
      if (state.open) {
        return state;
      }
      opened = true;
      return { open: true, draft: draft ?? null };
    });
    return opened;
  },
  setOpen: (open) =>
    set((state) => ({ open, draft: open ? state.draft : null })),
}));
