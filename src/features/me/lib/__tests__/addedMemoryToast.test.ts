import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(mocks.toast, { dismiss: mocks.dismiss }),
}));

import {
  resetAddedMemoryToasts,
  showAddedMemoryToast,
} from "../addedMemoryToast";
import type { AddedMemoryEntry } from "../meMemoryWrites";

function entry(overrides: Partial<AddedMemoryEntry> = {}): AddedMemoryEntry {
  return {
    id: "entry-1",
    ts: 1_700_000_000,
    content: "Kids' soccer is Mondays.",
    topic: "Home",
    path: "/home/u/.me/topics/home.md",
    agent: "noticer",
    sessionId: "sess-1",
    ...overrides,
  };
}

function show(
  overrides: Partial<Parameters<typeof showAddedMemoryToast>[0]> = {},
) {
  const onAcknowledge = vi.fn();
  const onDelete = vi.fn();
  const captured: {
    onOk?: () => void;
    onDelete?: () => void;
  } = {};
  showAddedMemoryToast({
    entry: entry(),
    destination: "In Home",
    title: "Added to memory",
    okLabel: "OK",
    deleteLabel: "Delete",
    onAcknowledge,
    onDelete,
    renderActions: ({ onOk, onDelete: onDeleteAction }) => {
      captured.onOk = onOk;
      captured.onDelete = onDeleteAction;
      return null;
    },
    ...overrides,
  });
  return { onAcknowledge, onDelete, captured };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAddedMemoryToasts();
  mocks.toast.mockReturnValue("toast-1");
});

describe("showAddedMemoryToast", () => {
  it("announces the entry and where it landed", () => {
    show();
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    const [title, options] = mocks.toast.mock.calls[0];
    expect(title).toBe("Added to memory");
    expect(options.description).toContain("Kids' soccer is Mondays.");
    expect(options.description).toContain("In Home");
  });

  it("only toasts an entry once, even across polls", () => {
    // The hook re-reads the queue on an interval, so the same entry comes
    // back until it's resolved — it must not re-toast each time.
    show();
    show();
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });

  it("dismisses the toast and acknowledges when OK is pressed", () => {
    const { onAcknowledge, captured } = show();
    captured.onOk?.();
    expect(mocks.dismiss).toHaveBeenCalledWith("toast-1");
    expect(onAcknowledge).toHaveBeenCalledWith(
      expect.objectContaining({ id: "entry-1" }),
    );
  });

  it("dismisses the toast and deletes when Delete is pressed", () => {
    const { onDelete, captured } = show();
    captured.onDelete?.();
    expect(mocks.dismiss).toHaveBeenCalledWith("toast-1");
    expect(onDelete).toHaveBeenCalledWith(
      expect.objectContaining({ id: "entry-1" }),
    );
  });
});
