import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { resolveSkillPillTone } from "../../lib/resolveSkillPillTone";
import { SkillEditor } from "../SkillEditor";

vi.mock("../../api/skills", () => ({
  createSkill: vi.fn().mockResolvedValue(undefined),
  updateSkill: vi.fn().mockResolvedValue({
    name: "test",
    description: "test",
    instructions: "",
    path: "",
    fileLocation: "/mock/.agents/skills/test/SKILL.md",
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createSkill, updateSkill } = await import("../../api/skills");

const defaultProps = {
  isOpen: true,
  onClose: vi.fn(),
  onSaved: vi.fn(),
};

describe("SkillEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Rendering ──────────────────────────────────────────────────────

  describe("rendering", () => {
    it("does not render when isOpen is false", () => {
      render(<SkillEditor {...defaultProps} isOpen={false} />);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("renders dialog when isOpen is true", () => {
      render(<SkillEditor {...defaultProps} />);
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it('shows "New Skill" title in create mode', () => {
      render(<SkillEditor {...defaultProps} />);
      expect(screen.getByText("New skill")).toBeInTheDocument();
    });

    it('shows "Edit Skill" title when editingSkill is provided', () => {
      render(
        <SkillEditor
          {...defaultProps}
          editingSkill={{
            name: "my-skill",
            description: "desc",
            instructions: "instr",
            path: "/mock/.agents/skills/my-skill",
            fileLocation: "/mock/.agents/skills/my-skill/SKILL.md",
            color: null,
          }}
        />,
      );
      expect(screen.getByText("Edit skill")).toBeInTheDocument();
    });
  });

  // ── Closing ───────────────────────────────────────────────────────

  describe("closing", () => {
    it("closes immediately when no fields have changed", async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(<SkillEditor {...defaultProps} onClose={onClose} />);

      await user.click(screen.getByRole("button", { name: "Cancel" }));

      expect(onClose).toHaveBeenCalledOnce();
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    it("asks for confirmation before closing with unsaved input", async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(<SkillEditor {...defaultProps} onClose={onClose} />);

      const nameInput = screen.getByPlaceholderText("my-skill-name");
      await user.type(nameInput, "work-in-progress");
      await user.click(screen.getByRole("button", { name: "Cancel" }));

      expect(onClose).not.toHaveBeenCalled();
      expect(
        screen.getByRole("alertdialog", {
          name: "Discard unsaved changes?",
        }),
      ).toBeInTheDocument();
      expect(nameInput).toHaveValue("work-in-progress");
    });

    it("keeps the editor and its input when discard is canceled", async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(<SkillEditor {...defaultProps} onClose={onClose} />);

      const nameInput = screen.getByPlaceholderText("my-skill-name");
      await user.type(nameInput, "work-in-progress");
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      await user.click(screen.getByRole("button", { name: "Keep editing" }));

      expect(onClose).not.toHaveBeenCalled();
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(nameInput).toHaveValue("work-in-progress");
    });

    it("discards input and closes after confirmation", async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(<SkillEditor {...defaultProps} onClose={onClose} />);

      await user.type(
        screen.getByPlaceholderText("my-skill-name"),
        "work-in-progress",
      );
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      await user.click(screen.getByRole("button", { name: "Discard" }));

      expect(onClose).toHaveBeenCalledOnce();
    });

    it("asks for confirmation when Escape would close dirty input", async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(<SkillEditor {...defaultProps} onClose={onClose} />);

      await user.type(
        screen.getByPlaceholderText("my-skill-name"),
        "work-in-progress",
      );
      await act(async () => {
        fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      });

      expect(onClose).not.toHaveBeenCalled();
      expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    });

    it("asks for confirmation when clicking outside dirty input", async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(<SkillEditor {...defaultProps} onClose={onClose} />);

      await user.type(
        screen.getByPlaceholderText("my-skill-name"),
        "work-in-progress",
      );
      const overlay = document.querySelector<HTMLElement>(
        '[data-slot="sheet-overlay"]',
      );
      expect(overlay).not.toBeNull();
      if (!overlay) throw new Error("Expected the skill editor overlay");
      await user.click(overlay);

      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    });

    it("treats pinning the derived color as an unsaved change", async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      const skillName = "code-review";
      render(
        <SkillEditor
          {...defaultProps}
          onClose={onClose}
          editingSkill={{
            name: skillName,
            description: "Reviews code",
            instructions: "Review carefully",
            path: "/mock/.agents/skills/code-review",
            fileLocation: "/mock/.agents/skills/code-review/SKILL.md",
            color: null,
          }}
        />,
      );

      const derivedColor = resolveSkillPillTone(skillName);
      await user.click(
        screen.getByRole("button", { name: `Color ${derivedColor}` }),
      );
      await user.click(screen.getByRole("button", { name: "Cancel" }));

      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    });

    it("ignores description whitespace that is trimmed when saved", async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(
        <SkillEditor
          {...defaultProps}
          onClose={onClose}
          editingSkill={{
            name: "code-review",
            description: "Reviews code",
            instructions: "Review carefully",
            path: "/mock/.agents/skills/code-review",
            fileLocation: "/mock/.agents/skills/code-review/SKILL.md",
            color: null,
          }}
        />,
      );

      const descriptionInput = screen.getByPlaceholderText(
        "What it does and when to use it...",
      );
      await user.type(descriptionInput, "   ");
      await user.click(screen.getByRole("button", { name: "Cancel" }));

      expect(onClose).toHaveBeenCalledOnce();
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    it("asks for confirmation before discarding edits to an existing skill", async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(
        <SkillEditor
          {...defaultProps}
          onClose={onClose}
          editingSkill={{
            name: "code-review",
            description: "Reviews code",
            instructions: "Review carefully",
            path: "/mock/.agents/skills/code-review",
            fileLocation: "/mock/.agents/skills/code-review/SKILL.md",
            color: null,
          }}
        />,
      );

      const descriptionInput = screen.getByPlaceholderText(
        "What it does and when to use it...",
      );
      await user.type(descriptionInput, " with extra care");
      await user.click(screen.getByRole("button", { name: "Cancel" }));

      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    });
  });

  // ── Name validation ────────────────────────────────────────────────

  describe("name validation", () => {
    it("allows consecutive hyphens to match backend validation", async () => {
      const user = userEvent.setup();
      render(<SkillEditor {...defaultProps} />);
      const nameInput = screen.getByPlaceholderText("my-skill-name");
      const descriptionInput = screen.getByPlaceholderText(
        "What it does and when to use it...",
      );

      await user.type(nameInput, "double--hyphen");
      await user.type(descriptionInput, "A valid description");

      expect(nameInput).toHaveValue("double--hyphen");
      expect(
        screen.queryByText(/cannot start or end with a hyphen/i),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /create skill/i }),
      ).toBeEnabled();
    });

    it("auto-formats input (uppercase to lowercase, spaces to hyphens)", async () => {
      const user = userEvent.setup();
      render(<SkillEditor {...defaultProps} />);
      const nameInput = screen.getByPlaceholderText("my-skill-name");

      await user.type(nameInput, "My Skill");
      expect(nameInput).toHaveValue("my-skill");
    });

    it("shows validation error for invalid name with trailing hyphen", async () => {
      const user = userEvent.setup();
      render(<SkillEditor {...defaultProps} />);
      const nameInput = screen.getByPlaceholderText("my-skill-name");

      await user.type(nameInput, "a-");
      expect(nameInput).toHaveValue("a-");
      expect(
        screen.getByText(/cannot start or end with a hyphen/i),
      ).toBeInTheDocument();
    });

    it("truncates names at 64 characters", async () => {
      const user = userEvent.setup();
      render(<SkillEditor {...defaultProps} />);
      const nameInput = screen.getByPlaceholderText("my-skill-name");
      const longName = "a".repeat(65);

      await user.type(nameInput, longName);

      expect(nameInput).toHaveValue("a".repeat(64));
      expect(
        screen.queryByText(/cannot start or end with a hyphen/i),
      ).not.toBeInTheDocument();
    });

    it("save button is disabled when name is empty", () => {
      render(<SkillEditor {...defaultProps} />);
      const saveButton = screen.getByRole("button", { name: /create skill/i });
      expect(saveButton).toBeDisabled();
    });
  });

  // ── Edit mode ──────────────────────────────────────────────────────

  describe("edit mode", () => {
    const editingSkill = {
      name: "code-review",
      description: "Reviews code",
      instructions: "Review the code carefully",
      path: "/mock/.agents/skills/code-review",
      fileLocation: "/mock/.agents/skills/code-review/SKILL.md",
      color: null,
    };

    it("pre-fills fields with existing skill data", () => {
      render(<SkillEditor {...defaultProps} editingSkill={editingSkill} />);
      expect(screen.getByPlaceholderText("my-skill-name")).toHaveValue(
        "code-review",
      );
      expect(
        screen.getByPlaceholderText("What it does and when to use it..."),
      ).toHaveValue("Reviews code");
      expect(
        screen.getByPlaceholderText(
          "Markdown instructions the agent will follow...",
        ),
      ).toHaveValue("Review the code carefully");
    });

    it("name field is editable in edit mode", async () => {
      const user = userEvent.setup();
      render(<SkillEditor {...defaultProps} editingSkill={editingSkill} />);
      const nameInput = screen.getByPlaceholderText("my-skill-name");

      await user.clear(nameInput);
      await user.type(nameInput, "renamed-skill");

      expect(nameInput).toHaveValue("renamed-skill");
    });

    it("shows the skill path on disk as minimal helper text in edit mode", () => {
      render(<SkillEditor {...defaultProps} editingSkill={editingSkill} />);

      expect(
        screen.getByText(
          "Path on disk: /mock/.agents/skills/code-review/SKILL.md",
        ),
      ).toBeInTheDocument();
    });

    it("updates the path helper text when the name changes in edit mode", async () => {
      const user = userEvent.setup();
      render(<SkillEditor {...defaultProps} editingSkill={editingSkill} />);

      const nameInput = screen.getByPlaceholderText("my-skill-name");
      await user.clear(nameInput);
      await user.type(nameInput, "renamed-skill");

      expect(
        screen.getByText(
          "Path on disk: /mock/.agents/skills/renamed-skill/SKILL.md",
        ),
      ).toBeInTheDocument();
    });

    it('save button text is "Save Changes" in edit mode', () => {
      render(<SkillEditor {...defaultProps} editingSkill={editingSkill} />);
      expect(
        screen.getByRole("button", { name: /save changes/i }),
      ).toBeInTheDocument();
    });

    it("allows editing skills whose names contain consecutive hyphens", () => {
      render(
        <SkillEditor
          {...defaultProps}
          editingSkill={{
            name: "double--hyphen",
            description: "Existing description",
            instructions: "Existing instructions",
            path: "/mock/.agents/skills/double--hyphen",
            fileLocation: "/mock/.agents/skills/double--hyphen/SKILL.md",
            color: null,
          }}
        />,
      );

      expect(
        screen.getByRole("button", { name: /save changes/i }),
      ).toBeEnabled();
      expect(
        screen.queryByText(/cannot start or end with a hyphen/i),
      ).not.toBeInTheDocument();
    });
  });

  // ── Form submission ────────────────────────────────────────────────

  describe("form submission", () => {
    it("calls createSkill API on save in create mode", async () => {
      const user = userEvent.setup();
      render(<SkillEditor {...defaultProps} />);

      await user.type(screen.getByPlaceholderText("my-skill-name"), "my-skill");
      await user.type(
        screen.getByPlaceholderText("What it does and when to use it..."),
        "A description",
      );
      await user.type(
        screen.getByPlaceholderText(
          "Markdown instructions the agent will follow...",
        ),
        "Some instructions",
      );
      await user.click(screen.getByRole("button", { name: /create skill/i }));

      expect(createSkill).toHaveBeenCalledWith(
        "my-skill",
        "A description",
        "Some instructions",
        expect.any(String),
        { projectId: undefined },
      );
    });

    it("calls updateSkill API on save in edit mode", async () => {
      const user = userEvent.setup();
      render(
        <SkillEditor
          {...defaultProps}
          editingSkill={{
            name: "code-review",
            description: "Reviews code",
            instructions: "Review carefully",
            path: "/mock/.agents/skills/code-review",
            fileLocation: "/mock/.agents/skills/code-review/SKILL.md",
            color: null,
          }}
        />,
      );

      // Change description
      const descInput = screen.getByPlaceholderText(
        "What it does and when to use it...",
      );
      await user.clear(descInput);
      await user.type(descInput, "Updated description");

      await user.click(screen.getByRole("button", { name: /save changes/i }));

      expect(updateSkill).toHaveBeenCalledWith(
        "/mock/.agents/skills/code-review",
        "code-review",
        "Updated description",
        "Review carefully",
        expect.any(String),
      );
    });

    it("calls updateSkill API with the renamed skill name in edit mode", async () => {
      const user = userEvent.setup();
      render(
        <SkillEditor
          {...defaultProps}
          editingSkill={{
            name: "code-review",
            description: "Reviews code",
            instructions: "Review carefully",
            path: "/mock/.agents/skills/code-review",
            fileLocation: "/mock/.agents/skills/code-review/SKILL.md",
            color: null,
          }}
        />,
      );

      const nameInput = screen.getByPlaceholderText("my-skill-name");
      await user.clear(nameInput);
      await user.type(nameInput, "renamed-skill");

      await user.click(screen.getByRole("button", { name: /save changes/i }));

      expect(updateSkill).toHaveBeenCalledWith(
        "/mock/.agents/skills/code-review",
        "renamed-skill",
        "Reviews code",
        "Review carefully",
        expect.any(String),
      );
    });

    it("calls onSaved callback after successful save", async () => {
      const user = userEvent.setup();
      const onSaved = vi.fn();
      render(<SkillEditor {...defaultProps} onSaved={onSaved} />);

      await user.type(screen.getByPlaceholderText("my-skill-name"), "my-skill");
      await user.type(
        screen.getByPlaceholderText("What it does and when to use it..."),
        "desc",
      );
      await user.click(screen.getByRole("button", { name: /create skill/i }));

      expect(onSaved).toHaveBeenCalled();
    });

    it("clears fields after save", async () => {
      const user = userEvent.setup();
      // Re-render with isOpen toggling to verify fields are cleared
      const { rerender } = render(<SkillEditor {...defaultProps} />);

      await user.type(screen.getByPlaceholderText("my-skill-name"), "my-skill");
      await user.type(
        screen.getByPlaceholderText("What it does and when to use it..."),
        "desc",
      );
      await user.click(screen.getByRole("button", { name: /create skill/i }));

      // Dialog closes after save; reopen to check fields are cleared
      rerender(<SkillEditor {...defaultProps} />);

      expect(screen.getByPlaceholderText("my-skill-name")).toHaveValue("");
      expect(
        screen.getByPlaceholderText("What it does and when to use it..."),
      ).toHaveValue("");
    });

    it("shows error message on save failure", async () => {
      const user = userEvent.setup();
      vi.mocked(createSkill).mockRejectedValueOnce(new Error("Network error"));

      render(<SkillEditor {...defaultProps} />);

      await user.type(screen.getByPlaceholderText("my-skill-name"), "my-skill");
      await user.type(
        screen.getByPlaceholderText("What it does and when to use it..."),
        "desc",
      );
      await user.click(screen.getByRole("button", { name: /create skill/i }));

      expect(screen.getByText(/network error/i)).toBeInTheDocument();
    });

    it("shows duplicate source failures as a skill name conflict", async () => {
      const user = userEvent.setup();
      const error = new Error("Invalid params") as Error & { data: string };
      error.name = "RequestError";
      error.data = "A source named 'my-skill' already exists";
      vi.mocked(createSkill).mockRejectedValueOnce(error);

      render(<SkillEditor {...defaultProps} />);

      const nameInput = screen.getByPlaceholderText("my-skill-name");
      await user.type(nameInput, "my-skill");
      await user.type(
        screen.getByPlaceholderText("What it does and when to use it..."),
        "desc",
      );
      await user.click(screen.getByRole("button", { name: /create skill/i }));

      expect(nameInput).toHaveAttribute("aria-invalid", "true");
      expect(
        screen.getByText('A skill named "my-skill" already exists'),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          "Choose a different name, or edit the existing skill instead.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByText("A source named 'my-skill' already exists"),
      ).not.toBeInTheDocument();
    });
  });
});
