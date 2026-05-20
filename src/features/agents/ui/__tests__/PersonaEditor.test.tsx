import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import type { Persona } from "@/shared/types/agents";
import { PersonaEditor } from "../PersonaEditor";

vi.mock("@/shared/api/acp", () => ({
  discoverAcpProviders: vi.fn(async () => []),
}));

vi.mock("@/features/providers/api/inventory", () => ({
  getProviderInventory: vi.fn(async () => []),
}));

function makePersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: "p1",
    displayName: "Scout",
    avatar: "https://example.test/scout.png",
    systemPrompt: "Research carefully.",
    isBuiltin: false,
    writable: true,
    sourceDescription: "Agent",
    sourceProperties: {
      avatar: "https://example.test/scout.png",
    },
    ...overrides,
  };
}

async function fillDisplayName(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText("e.g. Code Reviewer"), "Scout");
}

async function fillSystemPrompt(user: ReturnType<typeof userEvent.setup>) {
  await user.type(
    screen.getByPlaceholderText("Describe the agent's goal and instructions"),
    "Research.",
  );
}

describe("PersonaEditor", () => {
  it("omits avatar for new personas without a custom URL", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();

    renderWithProviders(
      <PersonaEditor isOpen onClose={vi.fn()} onSave={onSave} />,
    );

    await fillDisplayName(user);
    await fillSystemPrompt(user);
    await user.click(screen.getByRole("button", { name: /^create$/i }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        avatar: undefined,
        displayName: "Scout",
        systemPrompt: "Research.",
      }),
    );
  });

  it("saves a custom avatar URL for new personas", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();

    renderWithProviders(
      <PersonaEditor isOpen onClose={vi.fn()} onSave={onSave} />,
    );

    await user.type(
      screen.getByLabelText(/custom avatar url/i),
      "https://example.test/custom.png",
    );
    await fillDisplayName(user);
    await fillSystemPrompt(user);
    await user.click(screen.getByRole("button", { name: /^create$/i }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        avatar: "https://example.test/custom.png",
        displayName: "Scout",
        systemPrompt: "Research.",
      }),
    );
  });

  it("saves a bundled avatar for new personas", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();

    renderWithProviders(
      <PersonaEditor isOpen onClose={vi.fn()} onSave={onSave} />,
    );

    await user.click(screen.getByRole("button", { name: /gloopies/i }));
    await user.click(screen.getByRole("button", { name: /^gloopy 1$/i }));
    await fillDisplayName(user);
    await fillSystemPrompt(user);
    await user.click(screen.getByRole("button", { name: /^create$/i }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        avatar: "app-avatar:gloopy-1",
        displayName: "Scout",
        systemPrompt: "Research.",
      }),
    );
  });

  it("disables saving invalid custom avatar URLs", async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <PersonaEditor isOpen onClose={vi.fn()} onSave={vi.fn()} />,
    );

    const createButton = screen.getByRole("button", { name: /^create$/i });
    await user.type(screen.getByLabelText(/custom avatar url/i), "not-a-url");
    await fillDisplayName(user);
    await fillSystemPrompt(user);

    expect(screen.getByText(/enter a valid http or https url/i)).toBeVisible();
    expect(createButton).toBeDisabled();
  });

  it("does not submit an unchanged avatar while editing", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();

    renderWithProviders(
      <PersonaEditor
        isOpen
        mode="edit"
        persona={makePersona()}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        avatar: undefined,
      }),
    );
  });

  it("preserves non-url avatar sources when the open editor switches personas", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();

    const { rerender } = renderWithProviders(
      <PersonaEditor
        isOpen
        mode="edit"
        persona={makePersona()}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    rerender(
      <PersonaEditor
        isOpen
        mode="edit"
        persona={makePersona({
          id: "p2",
          displayName: "Builder",
          avatar: "app-avatar:gloopy-1",
          sourceProperties: { avatar: "app-avatar:gloopy-1" },
        })}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        avatar: undefined,
        displayName: "Builder",
      }),
    );
  });

  it("clears avatar to null while editing", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();

    renderWithProviders(
      <PersonaEditor
        isOpen
        mode="edit"
        persona={makePersona()}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    await user.clear(screen.getByLabelText(/custom avatar url/i));
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        avatar: null,
      }),
    );
  });

  it("keeps create disabled until required fields are populated", async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <PersonaEditor isOpen onClose={vi.fn()} onSave={vi.fn()} />,
    );

    const createButton = screen.getByRole("button", { name: /^create$/i });
    expect(createButton).toBeDisabled();

    await fillDisplayName(user);
    expect(createButton).toBeDisabled();

    await fillSystemPrompt(user);
    await waitFor(() => expect(createButton).toBeEnabled());
  });
});
