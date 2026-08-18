import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AvatarVisual } from "./avatar-visual";

const avatarHooks = vi.hoisted(() => ({
  image: undefined as string | undefined,
  media: undefined as
    | {
        src: string;
        mediaType: "image" | "video";
        posterSrc?: string;
      }
    | undefined,
}));

vi.mock("@/shared/hooks/useAvatarSrc", () => ({
  useAvatarImage: () => avatarHooks.image,
  useAvatarMedia: () => avatarHooks.media,
}));

vi.mock("@/shared/avatars/avatarPlaybackPreferences", () => ({
  useAnimatedAvatarsPreference: () => false,
}));

describe("AvatarVisual", () => {
  it("prefers the static image used by default avatars", () => {
    avatarHooks.image = "asset:///avatars/default.png";
    avatarHooks.media = {
      src: "asset:///avatars/default.webm",
      mediaType: "video",
    };

    render(<AvatarVisual avatar="app-avatar:default" alt="Default" />);

    expect(screen.getByRole("img", { name: "Default" })).toHaveAttribute(
      "src",
      "asset:///avatars/default.png",
    );
  });

  it("uses cached custom avatar media when no catalog image exists", () => {
    avatarHooks.image = undefined;
    avatarHooks.media = {
      src: "asset:///avatars/custom.webm",
      mediaType: "video",
      posterSrc: "asset:///avatars/custom.png",
    };

    render(<AvatarVisual avatar="user-avatar:custom" alt="Custom" />);

    expect(screen.getByRole("img", { name: "Custom" })).toHaveAttribute(
      "src",
      "asset:///avatars/custom.png",
    );
  });

  it("keeps image-only custom avatars visible", () => {
    avatarHooks.image = undefined;
    avatarHooks.media = {
      src: "asset:///avatars/custom.png",
      mediaType: "image",
    };

    render(<AvatarVisual avatar="user-avatar:custom" alt="Custom" />);

    expect(screen.getByRole("img", { name: "Custom" })).toHaveAttribute(
      "src",
      "asset:///avatars/custom.png",
    );
  });

  it("renders the caller fallback only when no avatar representation resolves", () => {
    avatarHooks.image = undefined;
    avatarHooks.media = undefined;

    render(
      <AvatarVisual
        avatar="user-avatar:missing"
        fallback={<span>Fallback</span>}
      />,
    );

    expect(screen.getByText("Fallback")).toBeInTheDocument();
  });
});
