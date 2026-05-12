import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PersonaCard } from "../PersonaCard";
import type { Persona } from "@/shared/types/agents";

function makePersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: "p1",
    displayName: "Goose Default",
    systemPrompt: "You are a helpful assistant that writes code.",
    isBuiltin: false,
    writable: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("PersonaCard", () => {
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

  it("shows avatar with initial", () => {
    render(<PersonaCard persona={makePersona({ displayName: "Alpha" })} />);
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("shows system prompt preview", () => {
    render(
      <PersonaCard
        persona={makePersona({ systemPrompt: "You are a coding assistant." })}
      />,
    );
    expect(screen.getByText("You are a coding assistant.")).toBeInTheDocument();
  });

  it("calls onSelect on click", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    const persona = makePersona();
    render(<PersonaCard persona={persona} onSelect={onSelect} />);

    await user.click(screen.getByLabelText(/^agent: /i));
    expect(onSelect).toHaveBeenCalledWith(persona);
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

    await user.click(screen.getByRole("button", { name: /agent options/i }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
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

  it("does not trigger selection when keyboard opens the options menu", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <PersonaCard
        persona={makePersona()}
        onSelect={onSelect}
        onDuplicate={vi.fn()}
      />,
    );

    screen.getByRole("button", { name: /agent options/i }).focus();
    await user.keyboard("{Enter}");

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
