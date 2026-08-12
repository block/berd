import { create } from "zustand";

interface ShortcutsDialogStore {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const useShortcutsDialogStore = create<ShortcutsDialogStore>()(
  (set) => ({
    open: false,
    setOpen: (open) => set({ open }),
    toggle: () => set((state) => ({ open: !state.open })),
  }),
);
