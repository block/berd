import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  MentionAutocomplete,
  type FileMentionItem,
  type SkillMentionItem,
  fuzzyMatch,
} from "../MentionAutocomplete";
import { Popover, PopoverAnchor } from "@/shared/ui/popover";
import type { Persona } from "@/shared/types/agents";

const PERSONAS: Persona[] = [
  {
    id: "solo",
    displayName: "Solo",
    systemPrompt: "",
    isBuiltin: true,
    writable: false,
    createdAt: "",
    updatedAt: "",
  },
  {
    id: "reviewer",
    displayName: "Reviewer",
    systemPrompt: "",
    isBuiltin: true,
    writable: false,
    createdAt: "",
    updatedAt: "",
  },
];

const FILES: FileMentionItem[] = [
  ...Array.from({ length: 12 }, (_, i) => ({
    resolvedPath: `/project/src/file${i}.ts`,
    displayPath: `src/file${i}.ts`,
    filename: `file${i}.ts`,
    kind: "file" as const,
    source: "project" as const,
  })),
  {
    resolvedPath: "/project/crates/sprout-acp/src/acp.rs",
    displayPath: "crates/sprout-acp/src/acp.rs",
    filename: "acp.rs",
    kind: "file" as const,
    source: "project" as const,
  },
  {
    resolvedPath: "/project/crates/sprout-acp/src/config.rs",
    displayPath: "crates/sprout-acp/src/config.rs",
    filename: "config.rs",
    kind: "file" as const,
    source: "project" as const,
  },
];

const SKILLS: SkillMentionItem[] = [
  {
    id: "global:/skills/code-review",
    name: "code-review",
    description: "Reviews code before it ships",
    sourceLabel: "Personal",
  },
];

function renderAutocomplete(props: {
  selectedIndex?: number;
  filteredPersonas?: Persona[];
  filteredSkills?: SkillMentionItem[];
  filteredFiles?: FileMentionItem[];
  trigger?: "@" | "/";
  atCategory?: "agents" | "files" | "skills";
  onAtCategoryChange?: (category: "agents" | "files" | "skills") => void;
}) {
  const atCategory =
    props.atCategory ?? (props.trigger === "/" ? "skills" : "agents");
  return render(
    <Popover open>
      <PopoverAnchor asChild>
        <div />
      </PopoverAnchor>
      <MentionAutocomplete
        filteredPersonas={props.filteredPersonas ?? PERSONAS}
        filteredSkills={props.filteredSkills ?? []}
        filteredFiles={props.filteredFiles ?? FILES}
        isOpen
        atCategory={atCategory}
        onAtCategoryChange={props.onAtCategoryChange}
        onSelectPersona={vi.fn()}
        onSelectSkill={vi.fn()}
        onSelectFile={vi.fn()}
        selectedIndex={props.selectedIndex}
      />
    </Popover>,
  );
}

describe("MentionAutocomplete", () => {
  it("renders agent tabs by default", () => {
    renderAutocomplete({});
    expect(screen.getByText("Solo")).toBeInTheDocument();
    expect(screen.queryByText("file0.ts")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Agents" })).toHaveAttribute(
      "data-state",
      "active",
    );
    expect(screen.getByRole("tab", { name: "Files" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Skills" })).toBeInTheDocument();
  });

  it("renders file items in the files tab", () => {
    renderAutocomplete({ atCategory: "files" });
    expect(screen.getByText("file0.ts")).toBeInTheDocument();
    expect(screen.queryByText("Solo")).not.toBeInTheDocument();
  });

  it("changes @ categories when tabs are clicked", async () => {
    const user = userEvent.setup();
    const onAtCategoryChange = vi.fn();
    renderAutocomplete({ onAtCategoryChange });

    await user.click(screen.getByRole("tab", { name: "Files" }));
    expect(onAtCategoryChange).toHaveBeenCalledTimes(1);
    expect(onAtCategoryChange).toHaveBeenCalledWith("files");

    await user.click(screen.getByRole("tab", { name: "Skills" }));
    expect(onAtCategoryChange).toHaveBeenCalledTimes(2);
    expect(onAtCategoryChange).toHaveBeenCalledWith("skills");

    await user.click(screen.getByRole("tab", { name: "Agents" }));
    expect(onAtCategoryChange).toHaveBeenCalledTimes(3);
    expect(onAtCategoryChange).toHaveBeenCalledWith("agents");
  });

  it("highlights matched characters from the backend matcher", () => {
    renderAutocomplete({
      atCategory: "files",
      filteredFiles: [
        {
          resolvedPath: "/project/readme.md",
          displayPath: "project/readme.md",
          filename: "readme.md",
          kind: "file" as const,
          source: "project" as const,
          matchHighlight: { target: "filename", indices: [0, 3, 4, 5] },
        },
      ],
    });

    const option = screen.getByRole("option", { name: /readme\.md/ });
    const highlighted = option.querySelectorAll("span.text-primary");
    expect(
      Array.from(highlighted)
        .map((span) => span.textContent)
        .join(""),
    ).toBe("rdme");
  });

  it("does not highlight shortcut entries with substituted labels", () => {
    renderAutocomplete({
      atCategory: "files",
      filteredFiles: [
        {
          resolvedPath: "/Users/me",
          displayPath: "/Users/me",
          filename: "me",
          kind: "path" as const,
          source: "home" as const,
          shortcut: "home" as const,
          matchHighlight: { target: "filename", indices: [0, 1] },
        },
      ],
    });

    const option = screen.getByRole("option", { name: /home/i });
    expect(option.querySelectorAll("span.text-primary")).toHaveLength(0);
  });

  it("renders skill items", () => {
    renderAutocomplete({
      trigger: "/",
      filteredSkills: SKILLS,
      filteredFiles: [],
      filteredPersonas: [],
    });
    expect(screen.getByText("Skills")).toBeInTheDocument();
    expect(screen.getByText("code-review")).toBeInTheDocument();
    expect(
      screen.getByText("Reviews code before it ships"),
    ).toBeInTheDocument();
  });

  it("calls scrollIntoView on the selected item", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    const { rerender } = render(
      <Popover open>
        <PopoverAnchor asChild>
          <div />
        </PopoverAnchor>
        <MentionAutocomplete
          filteredPersonas={PERSONAS}
          filteredSkills={[]}
          filteredFiles={FILES}
          isOpen
          atCategory="files"
          onSelectPersona={vi.fn()}
          onSelectSkill={vi.fn()}
          onSelectFile={vi.fn()}
          selectedIndex={0}
        />
      </Popover>,
    );

    scrollIntoView.mockClear();

    rerender(
      <Popover open>
        <PopoverAnchor asChild>
          <div />
        </PopoverAnchor>
        <MentionAutocomplete
          filteredPersonas={PERSONAS}
          filteredSkills={[]}
          filteredFiles={FILES}
          isOpen
          atCategory="files"
          onSelectPersona={vi.fn()}
          onSelectSkill={vi.fn()}
          onSelectFile={vi.fn()}
          selectedIndex={10}
        />
      </Popover>,
    );

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("marks only the selected item as aria-selected", () => {
    renderAutocomplete({ atCategory: "files", selectedIndex: 3 });

    const options = screen.getAllByRole("option");
    for (let i = 0; i < options.length; i++) {
      if (i === 3) {
        expect(options[i]).toHaveAttribute("aria-selected", "true");
      } else {
        expect(options[i]).toHaveAttribute("aria-selected", "false");
      }
    }
  });

  it("returns null when not open", () => {
    const { container } = render(
      <Popover open>
        <PopoverAnchor asChild>
          <div />
        </PopoverAnchor>
        <MentionAutocomplete
          filteredPersonas={PERSONAS}
          filteredSkills={[]}
          filteredFiles={FILES}
          isOpen={false}
          onSelectPersona={vi.fn()}
          onSelectSkill={vi.fn()}
          onSelectFile={vi.fn()}
        />
      </Popover>,
    );

    expect(container.querySelector("[role='listbox']")).not.toBeInTheDocument();
  });

  it("renders loading, empty, and error states without footer help text", () => {
    const { rerender } = render(
      <Popover open>
        <PopoverAnchor asChild>
          <div />
        </PopoverAnchor>
        <MentionAutocomplete
          filteredPersonas={[]}
          filteredSkills={[]}
          filteredFiles={[]}
          isOpen
          atCategory="files"
          pathsLoading
          onSelectPersona={vi.fn()}
        />
      </Popover>,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Loading paths...");
    expect(
      within(screen.getByRole("listbox")).queryByText("Loading paths..."),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Enter")).not.toBeInTheDocument();
    expect(screen.queryByText("to insert")).not.toBeInTheDocument();

    rerender(
      <Popover open>
        <PopoverAnchor asChild>
          <div />
        </PopoverAnchor>
        <MentionAutocomplete
          filteredPersonas={[]}
          filteredSkills={[]}
          filteredFiles={[]}
          isOpen
          atCategory="files"
          onSelectPersona={vi.fn()}
        />
      </Popover>,
    );

    expect(screen.getByRole("status")).toHaveTextContent("No matches");
    expect(
      within(screen.getByRole("listbox")).queryByText("No matches"),
    ).not.toBeInTheDocument();

    rerender(
      <Popover open>
        <PopoverAnchor asChild>
          <div />
        </PopoverAnchor>
        <MentionAutocomplete
          filteredPersonas={[]}
          filteredSkills={[]}
          filteredFiles={[]}
          isOpen
          atCategory="files"
          pathsError="load-error"
          onSelectPersona={vi.fn()}
        />
      </Popover>,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Couldn't load paths");
    expect(
      within(screen.getByRole("listbox")).queryByText("Couldn't load paths"),
    ).not.toBeInTheDocument();
  });

  it("renders active category items with stable option ids", () => {
    renderAutocomplete({
      selectedIndex: 0,
      atCategory: "files",
      filteredFiles: FILES.slice(0, 1),
    });

    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("file0.ts"),
    ]);
    expect(options[0]).toHaveAttribute(
      "id",
      "mention-autocomplete-listbox-option-0",
    );
    expect(options[0]).toHaveAttribute("aria-selected", "true");
  });
});

describe("fuzzyMatch", () => {
  it("matches exact substrings", () => {
    expect(fuzzyMatch("solo", "solo")).toBe(true);
  });

  it("matches subsequences", () => {
    expect(fuzzyMatch("slo", "solo")).toBe(true);
  });

  it("rejects non-subsequences", () => {
    expect(fuzzyMatch("xyz", "solo")).toBe(false);
  });

  it("matches path-style queries against file paths", () => {
    expect(
      fuzzyMatch("crates/sprout-acp/.rs", "crates/sprout-acp/src/acp.rs"),
    ).toBe(true);
    expect(
      fuzzyMatch("crates/sprout-acp/.rs", "crates/sprout-acp/src/config.rs"),
    ).toBe(true);
  });

  it("rejects unrelated paths", () => {
    expect(fuzzyMatch("crates/sprout-acp/.rs", "src/file0.ts")).toBe(false);
  });
});
