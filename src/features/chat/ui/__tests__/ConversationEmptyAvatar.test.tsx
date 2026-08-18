import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConversationEmptyAvatar } from "../ConversationEmptyAvatar";

const mockUseAvatarMedia = vi.hoisted(() =>
  vi.fn<(avatar: unknown) => unknown>(),
);
const mockUseAvatarImage = vi.hoisted(() =>
  vi.fn<(avatar: unknown) => unknown>(),
);
const mockResolveAgentIcon = vi.hoisted(() =>
  vi.fn<(personaId: unknown) => string>(() => "fallback-gloopy.png"),
);

vi.mock("@/shared/hooks/useAvatarSrc", () => ({
  useAvatarMedia: (avatar: unknown) => mockUseAvatarMedia(avatar),
  useAvatarImage: (avatar: unknown) => mockUseAvatarImage(avatar),
}));

vi.mock("@/features/agents/lib/resolveAgentIcon", () => ({
  resolveAgentIcon: (personaId: unknown) => mockResolveAgentIcon(personaId),
}));

describe("ConversationEmptyAvatar", () => {
  it("renders cached custom avatar media before falling back to the generated agent icon", () => {
    mockUseAvatarMedia.mockReturnValue({
      src: "asset:///avatars/custom.webm",
      mediaType: "video",
      posterSrc: "asset:///avatars/custom.png",
    });
    mockUseAvatarImage.mockReturnValue(undefined);

    render(
      <ConversationEmptyAvatar
        persona={{
          id: "custom",
          displayName: "Custom",
          systemPrompt: "Custom.",
          avatar: "user-avatar:custom",
          isBuiltin: false,
          writable: true,
        }}
      />,
    );

    expect(document.querySelector("img")).toHaveAttribute(
      "src",
      "asset:///avatars/custom.png",
    );
  });

  it("uses the selected avatar image before falling back to the generated agent icon", () => {
    mockUseAvatarMedia.mockReturnValue(undefined);
    mockUseAvatarImage.mockReturnValue("asset:///avatars/polys/libra.png");

    render(
      <ConversationEmptyAvatar
        persona={{
          id: "libra",
          displayName: "Libra",
          systemPrompt: "Stars.",
          avatar: "app-avatar:polys-libra",
          isBuiltin: false,
          writable: true,
        }}
      />,
    );

    expect(document.querySelector("img")).toHaveAttribute(
      "src",
      "asset:///avatars/polys/libra.png",
    );
  });

  it("falls back to the generated agent icon only when no avatar media or image is available", () => {
    mockUseAvatarMedia.mockReturnValue(undefined);
    mockUseAvatarImage.mockReturnValue(undefined);

    render(
      <ConversationEmptyAvatar
        persona={{
          id: "fallback-agent",
          displayName: "Fallback",
          systemPrompt: "Fallback.",
          avatar: "app-avatar:missing",
          isBuiltin: false,
          writable: true,
        }}
      />,
    );

    expect(document.querySelector("img")).toHaveAttribute(
      "src",
      "fallback-gloopy.png",
    );
  });
});
