import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  importMemoryMarkdown: vi.fn(),
  exportMemoryMarkdown: vi.fn(),
}));
vi.mock("@/shared/api/system", () => mocks);
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));
import { DocumentPanel } from "../MeSettings";
const props = {
  contents: "# Me\n\n- Original preference.",
  path: "/fixture/.me/me.md",
  onSave: vi.fn(),
  editorLabel: "Edit memory",
  saveErrorText: "Could not save",
  unsafeUnicodeErrorText: "Unsafe text",
  cancelText: "Cancel",
  saveText: "Save",
  previewText: "Preview",
  editText: "Edit",
  unsavedText: "Unsaved changes",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
});
describe("Markdown portability", () => {
  it("blocks Save while import is pending, then requires explicit Save for the imported draft", async () => {
    const user = userEvent.setup();
    const picker = deferred<string | null>();
    mocks.importMemoryMarkdown.mockReturnValue(picker.promise);
    const { rerender } = render(<DocumentPanel {...props} />);
    await user.click(screen.getByRole("tab", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Import Markdown" }));
    expect(mocks.importMemoryMarkdown).toHaveBeenCalledExactlyOnceWith();

    // A refresh can change saved contents while the native picker is open.
    // Keep a distinct draft so Save must be blocked by busy, not by a clean draft.
    rerender(<DocumentPanel {...props} contents="# Refreshed memory" />);
    const editor = screen.getByRole("textbox", { name: "Edit memory" });
    const save = screen.getByRole("button", { name: "Save" });
    expect(editor).toHaveValue(props.contents);
    expect(editor).toBeDisabled();
    expect(save).toBeDisabled();
    await user.click(save);
    expect(props.onSave).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Import Markdown" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Export Markdown" }),
    ).toBeDisabled();

    const imported = "# Imported\n\n- Review this deferred import.";
    await act(async () => picker.resolve(imported));
    expect(editor).toHaveValue(imported);
    expect(editor).toBeEnabled();
    expect(save).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("unsaved draft");
    expect(props.onSave).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Import Markdown" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Export Markdown" }),
    ).toBeDisabled();

    await user.click(save);
    expect(props.onSave).toHaveBeenCalledExactlyOnceWith(imported);
    expect(mocks.exportMemoryMarkdown).not.toHaveBeenCalled();
  });

  it.each([
    "canceled",
    "rejected",
  ])("preserves the existing draft and saved document without writing when a pending import is %s", async (outcome) => {
    const user = userEvent.setup();
    const picker = deferred<string | null>();
    mocks.importMemoryMarkdown.mockReturnValue(picker.promise);
    const { rerender } = render(<DocumentPanel {...props} />);
    await user.click(screen.getByRole("tab", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Import Markdown" }));
    expect(mocks.importMemoryMarkdown).toHaveBeenCalledExactlyOnceWith();

    // Distinguish the existing draft from refreshed saved contents, so resetting
    // the draft on cancellation or failure cannot pass unnoticed.
    rerender(<DocumentPanel {...props} contents="# Refreshed memory" />);
    expect(screen.getByRole("textbox")).toHaveValue(props.contents);
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(props.onSave).not.toHaveBeenCalled();
    await act(async () => {
      if (outcome === "canceled") picker.resolve(null);
      else picker.reject(new Error("fixture import failure"));
    });

    expect(screen.getByRole("textbox")).toHaveValue(props.contents);
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    if (outcome === "rejected") {
      expect(screen.getByRole("alert")).toHaveTextContent("Couldn't import");
    } else {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    }
    expect(props.onSave).not.toHaveBeenCalled();
    expect(mocks.exportMemoryMarkdown).not.toHaveBeenCalled();

    await user.click(screen.getByRole("tab", { name: "Preview" }));
    expect(
      screen.getByRole("heading", { name: "Refreshed memory" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Edit" }));
    expect(screen.getByRole("textbox")).toHaveValue(props.contents);
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it("imports only an unsaved draft, then requires an explicit Save", async () => {
    const user = userEvent.setup();
    mocks.importMemoryMarkdown.mockResolvedValue("# Imported\n\n- Review me.");
    render(<DocumentPanel {...props} />);
    await user.click(screen.getByRole("button", { name: "Import Markdown" }));
    expect(screen.getByRole("textbox", { name: "Edit memory" })).toHaveValue(
      "# Imported\n\n- Review me.",
    );
    expect(screen.getByRole("status")).toHaveTextContent("unsaved draft");
    expect(props.onSave).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Export Markdown" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Import Markdown" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(props.onSave).toHaveBeenCalledExactlyOnceWith(
      "# Imported\n\n- Review me.",
    );
  });
  it("can discard imported text without saving", async () => {
    const user = userEvent.setup();
    mocks.importMemoryMarkdown.mockResolvedValue("# Imported");
    render(<DocumentPanel {...props} />);
    await user.click(screen.getByRole("button", { name: "Import Markdown" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Original preference.")).toBeInTheDocument();
    expect(props.onSave).not.toHaveBeenCalled();
  });
  it("keeps imported text when Save fails", async () => {
    const user = userEvent.setup();
    mocks.importMemoryMarkdown.mockResolvedValue("# Imported");
    props.onSave.mockRejectedValue(new Error("locked"));
    render(<DocumentPanel {...props} />);
    await user.click(screen.getByRole("button", { name: "Import Markdown" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("textbox")).toHaveValue("# Imported");
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save");
  });
  it("does nothing when the import picker is canceled", async () => {
    const user = userEvent.setup();
    mocks.importMemoryMarkdown.mockResolvedValue(null);
    render(<DocumentPanel {...props} />);
    await user.click(screen.getByRole("button", { name: "Import Markdown" }));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(props.onSave).not.toHaveBeenCalled();
  });
  it("shows import failure without changing the saved document", async () => {
    const user = userEvent.setup();
    mocks.importMemoryMarkdown.mockRejectedValue(new Error("unsafe text"));
    render(<DocumentPanel {...props} />);
    await user.click(screen.getByRole("button", { name: "Import Markdown" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't import");
    expect(screen.getByText("Original preference.")).toBeInTheDocument();
    expect(props.onSave).not.toHaveBeenCalled();
  });
  it("warns before exporting saved content through the native picker", async () => {
    const user = userEvent.setup();
    mocks.exportMemoryMarkdown.mockResolvedValue("/fixture-export/me.md");
    render(<DocumentPanel {...props} />);
    await user.click(screen.getByRole("button", { name: "Export Markdown" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "will not be encrypted",
    );
    expect(mocks.exportMemoryMarkdown).not.toHaveBeenCalled();
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Export Markdown",
      }),
    );
    await waitFor(() =>
      expect(mocks.exportMemoryMarkdown).toHaveBeenCalledExactlyOnceWith(
        props.path,
      ),
    );
    expect(props.onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "plaintext Markdown export",
    );
  });
  it("does not export when warning is canceled", async () => {
    const user = userEvent.setup();
    render(<DocumentPanel {...props} />);
    await user.click(screen.getByRole("button", { name: "Export Markdown" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.exportMemoryMarkdown).not.toHaveBeenCalled();
  });
  it.each([
    "cancel",
    "failure",
  ])("handles export %s without a success message or document write", async (outcome) => {
    const user = userEvent.setup();
    if (outcome === "cancel")
      mocks.exportMemoryMarkdown.mockResolvedValue(null);
    else
      mocks.exportMemoryMarkdown.mockRejectedValue(
        new Error("blocked destination"),
      );
    render(<DocumentPanel {...props} />);
    await user.click(screen.getByRole("button", { name: "Export Markdown" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Export Markdown",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(props.onSave).not.toHaveBeenCalled();
    if (outcome === "failure")
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Couldn't export Markdown",
      );
  });
  it("cannot export an unsaved new document", () => {
    render(<DocumentPanel {...props} path={undefined} />);
    expect(
      screen.getByRole("button", { name: "Export Markdown" }),
    ).toBeDisabled();
  });
});
