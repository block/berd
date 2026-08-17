import { beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { resetHomeWidgetStoreForTests } from "@/features/home/stores/homeWidgetStore";
import { PersonaCard } from "../PersonaCard";
import type { Persona } from "@/shared/types/agents";

const avatarMediaMocks = vi.hoisted(() => ({
  media: undefined as
    | { src: string; mediaType: "image" | "video"; posterSrc?: string }
    | undefined,
  image: undefined as string | undefined,
}));

vi.mock("@/shared/hooks/useAvatarSrc", () => ({
  useAvatarMedia: () => avatarMediaMocks.media,
  useAvatarImage: () => avatarMediaMocks.image,
}));

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
    avatarMediaMocks.media = undefined;
    avatarMediaMocks.image = undefined;
  });

  it("renders persona name", () => {
    render(<PersonaCard persona={makePersona({ displayName: "Coder" })} />);
    expect(screen.getByText("Coder")).toBeInTheDocument();
  });

  it("autoplays animated avatars without scroll-triggered loading", () => {
    avatarMediaMocks.media = {
      src: "asset://animated.mp4",
      mediaType: "video",
      posterSrc: "asset://still.png",
    };
    avatarMediaMocks.image = "asset://still.png";
    const { container } = render(
      <PersonaCard persona={makePersona({ avatar: "user-avatar:one" })} />,
    );

    expect(screen.queryByRole("img", { name: "Berd Default" })).toHaveAttribute(
      "src",
      "asset://still.png",
    );
    const video = container.querySelector("video");
    const still = container.querySelector('img[src="asset://still.png"]');
    expect(video).toHaveAttribute("src", "asset://animated.mp4");
    expect(video).toHaveClass("opacity-0");
    expect(still).not.toHaveClass("opacity-0");

    fireEvent.loadedData(video as HTMLVideoElement);
    expect(video).toHaveClass("opacity-100");
    expect(still).toHaveClass("opacity-0");
  });

  it("keeps the next poster visible until a changed video is ready", () => {
    avatarMediaMocks.media = {
      src: "asset://first.mp4",
      mediaType: "video",
      posterSrc: "asset://first.png",
    };
    avatarMediaMocks.image = "asset://first.png";
    const persona = makePersona({ avatar: "user-avatar:first" });
    const { container, rerender } = render(<PersonaCard persona={persona} />);
    fireEvent.loadedData(container.querySelector("video") as HTMLVideoElement);

    avatarMediaMocks.media = {
      src: "asset://second.mp4",
      mediaType: "video",
      posterSrc: "asset://second.png",
    };
    avatarMediaMocks.image = "asset://second.png";
    rerender(
      <PersonaCard persona={{ ...persona, avatar: "user-avatar:second" }} />,
    );

    expect(
      container.querySelector('img[src="asset://second.png"]'),
    ).not.toHaveClass("opacity-0");
    expect(
      container.querySelector('video[src="asset://second.mp4"]'),
    ).toHaveClass("opacity-0");
  });

  it("uses the first video frame when no static avatar exists", () => {
    avatarMediaMocks.media = {
      src: "asset://animated-without-poster.mp4",
      mediaType: "video",
    };
    const { container } = render(
      <PersonaCard persona={makePersona({ avatar: "user-avatar:legacy" })} />,
    );

    const video = container.querySelector("video");
    expect(video).toHaveAttribute("src", "asset://animated-without-poster.mp4");
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      expect.stringContaining("goose-"),
    );
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

  it("shows the agent's description, not its instructions", () => {
    render(
      <PersonaCard
        persona={makePersona({
          systemPrompt: "You are a coding assistant.",
          sourceDescription: "Reviews your code and catches bugs.",
        })}
      />,
    );
    expect(
      screen.getByText("Reviews your code and catches bugs."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("You are a coding assistant."),
    ).not.toBeInTheDocument();
  });

  it("falls back to instructions when there's no real description", () => {
    render(
      <PersonaCard
        persona={makePersona({
          systemPrompt: "You are a coding assistant.",
          sourceDescription: undefined,
        })}
      />,
    );
    expect(screen.getByText("You are a coding assistant.")).toBeInTheDocument();
  });

  it("falls back to instructions when the description is a placeholder", () => {
    render(
      <PersonaCard
        persona={makePersona({
          systemPrompt: "You are a coding assistant.",
          sourceDescription: "Agent",
        })}
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

  it("calls onShare from the options menu", async () => {
    const onShare = vi.fn();
    const user = userEvent.setup();
    const persona = makePersona();
    render(<PersonaCard persona={persona} onShare={onShare} />);

    await user.click(screen.getByRole("button", { name: /agent options/i }));
    await user.click(screen.getByRole("menuitem", { name: /share agent/i }));

    expect(onShare).toHaveBeenCalledWith(persona);
  });

  it("shows Export when no share handler is provided", async () => {
    const onExport = vi.fn();
    const user = userEvent.setup();
    const persona = makePersona();
    render(<PersonaCard persona={persona} onExport={onExport} />);

    await user.click(screen.getByRole("button", { name: /agent options/i }));
    await user.click(screen.getByRole("menuitem", { name: /export/i }));

    expect(onExport).toHaveBeenCalledWith(persona);
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
