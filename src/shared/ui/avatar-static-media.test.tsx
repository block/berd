import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AvatarStaticMedia } from "./avatar-static-media";

interface MockAvatarMediaProps {
  onReady?: () => void;
  onError?: () => void;
}

const avatarMediaProps = vi.fn<(props: MockAvatarMediaProps) => void>();

vi.mock("@/shared/ui/avatar-media", () => ({
  AvatarMedia: (props: MockAvatarMediaProps) => {
    avatarMediaProps(props);
    return <canvas data-testid="connected-avatar-decoder" />;
  },
}));

let mediaIndex = 0;
function media() {
  mediaIndex += 1;
  return {
    src: `asset://localhost/avatar-${mediaIndex}.mp4`,
    mediaType: "video" as const,
    alphaMode: "stacked" as const,
  };
}

function mockSuccessfulCanvasCapture() {
  const pixels = new Uint8ClampedArray(4);
  pixels[3] = 255;
  const getImageData = vi.fn(() => ({ data: pixels }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    getImageData,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
    "data:image/png;base64,visible",
  );
  Object.defineProperties(HTMLCanvasElement.prototype, {
    width: { configurable: true, get: () => 1 },
    height: { configurable: true, get: () => 1 },
  });
  return getImageData;
}

beforeEach(() => {
  avatarMediaProps.mockClear();
  vi.restoreAllMocks();
});

describe("AvatarStaticMedia", () => {
  it("transfers ownership to an already-mounted follower", async () => {
    const avatarMedia = media();
    const { rerender } = render(
      <>
        <AvatarStaticMedia
          key="owner"
          media={avatarMedia}
          fallback={<span>owner</span>}
        />
        <AvatarStaticMedia
          key="follower"
          media={avatarMedia}
          fallback={<span>follower</span>}
        />
      </>,
    );
    await screen.findByTestId("connected-avatar-decoder");
    expect(screen.getAllByTestId("connected-avatar-decoder")).toHaveLength(1);

    rerender(
      <AvatarStaticMedia
        key="follower"
        media={avatarMedia}
        fallback={<span>follower</span>}
      />,
    );

    await waitFor(() =>
      expect(screen.getAllByTestId("connected-avatar-decoder")).toHaveLength(1),
    );
  });

  it("retries a thrown capture while the occurrence remains mounted", async () => {
    const readPixels = mockSuccessfulCanvasCapture();
    readPixels.mockImplementationOnce(() => {
      throw new DOMException("not readable");
    });

    render(<AvatarStaticMedia media={media()} fallback={<span>Q</span>} />);
    await screen.findByTestId("connected-avatar-decoder");

    act(() => avatarMediaProps.mock.lastCall?.[0].onReady?.());

    await waitFor(() => expect(avatarMediaProps).toHaveBeenCalledTimes(2));
    act(() => avatarMediaProps.mock.lastCall?.[0].onReady?.());

    await waitFor(() =>
      expect(document.querySelector("img")).toHaveAttribute(
        "src",
        "data:image/png;base64,visible",
      ),
    );
    expect(readPixels).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByTestId("connected-avatar-decoder"),
    ).not.toBeInTheDocument();
  });

  it("releases a decoder that never becomes ready", async () => {
    vi.useFakeTimers();
    const avatarMedia = media();
    render(<AvatarStaticMedia media={avatarMedia} fallback={<span>Q</span>} />);
    await act(async () => {});
    expect(screen.getByTestId("connected-avatar-decoder")).toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(8_000));
    expect(avatarMediaProps).toHaveBeenCalledTimes(2);

    await act(async () => vi.advanceTimersByTimeAsync(8_000));
    expect(
      screen.queryByTestId("connected-avatar-decoder"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Q")).toBeInTheDocument();
    vi.useRealTimers();
  });
});
