import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { resetHomeWidgetStoreForTests } from "@/features/home/stores/homeWidgetStore";
import { PersonaCard } from "../PersonaCard";
import type { Persona } from "@/shared/types/agents";

function makePersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: "p1",
    displayName: "Berd Default",
    systemPrompt: "You are a helpful assistant that writes code.",
    isBuiltin: false,
    writable: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("PersonaCard", () => {
  beforeEach(() => {
    resetHomeWidgetStoreForTests();
  });

  it("renders persona name", () => {
    render(<PersonaCard persona={makePersona({ displayName: "Coder" })} />);
    expect(screen.getByText("Coder")).toBeInTheDocument();
  });

  it("does not show source tags", () => {
    render(
      <>
        <PersonaCard
          persona={makePersona({
            id: "builtin",
            isBuiltin: true,
            writable: false,
          })}
        />
        <PersonaCard persona={makePersona({ id: "file", writable: true })} />
      </>,
    );
    expect(screen.queryByText("Built-in")).not.toBeInTheDocument();
    expect(screen.queryByText("File-backed")).not.toBeInTheDocument();
  });

  it("does not show provider or model metadata", () => {
    render(
      <PersonaCard
        persona={makePersona({
          displayName: "Agent One",
          provider: "goose",
          model: "claude-sonnet-4-20250514",
        })}
      />,
    );

    expect(screen.queryByText(/goose/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/claude-sonnet/i)).not.toBeInTheDocument();
  });

  it("shows system prompt preview", () => {
    render(
      <PersonaCard
        persona={makePersona({ systemPrompt: "You are a coding assistant." })}
      />,
    );
    expect(screen.getByText("You are a coding assistant.")).toBeInTheDocument();
  });

  it("calls onSelect when the View action is clicked", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    const persona = makePersona();
    render(<PersonaCard persona={persona} onSelect={onSelect} />);

    const viewButton = screen.getByRole("button", {
      name: /^view Berd default$/i,
    });
    expect(viewButton).toHaveClass("bg-surface-agent-tile-action-bg");
    expect(viewButton.parentElement).toHaveClass(
      "opacity-0",
      "focus-within:opacity-100",
    );
    expect(viewButton.parentElement).not.toHaveClass("hidden");

    await user.click(viewButton);
    expect(onSelect).toHaveBeenCalledWith(persona);
  });

  it("calls onStartChat when the Chat action is clicked", async () => {
    const onStartChat = vi.fn();
    const user = userEvent.setup();
    const persona = makePersona();
    render(<PersonaCard persona={persona} onStartChat={onStartChat} />);

    await user.click(
      screen.getByRole("button", { name: /^chat with Berd default$/i }),
    );
    expect(onStartChat).toHaveBeenCalledWith(persona);
  });

  it("shows dropdown menu on options button click", async () => {
    const user = userEvent.setup();
    render(
      <PersonaCard
        persona={makePersona()}
        onEdit={vi.fn()}
        onDuplicate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    const optionsButton = screen.getByRole("button", {
      name: /agent options/i,
    });
    expect(optionsButton).toHaveClass(
      "opacity-0",
      "group-hover:opacity-100",
      "focus-visible:opacity-100",
      "data-[state=open]:opacity-100",
    );

    await user.click(optionsButton);
    expect(screen.getByRole("menu")).toHaveClass("shadow-mini");
    expect(
      screen.getByRole("menuitem", { name: /pin to home/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /edit/i })).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /duplicate/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /delete/i }),
    ).toBeInTheDocument();
  });

  it("delete is disabled for built-in personas", async () => {
    const user = userEvent.setup();
    render(
      <PersonaCard
        persona={makePersona({ isBuiltin: true, writable: false })}
        onDelete={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /agent options/i }));
    const deleteBtn = screen.queryByRole("menuitem", { name: /delete/i });
    expect(deleteBtn).toBeNull();
  });

  it("renders an illustrated agent icon image", () => {
    const { container } = render(
      <PersonaCard persona={makePersona({ id: "stable-id" })} />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src") ?? "").toBeTruthy();
  });
});
