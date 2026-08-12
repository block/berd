import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { PhotoWidget } from "./PhotoWidget";
import type { WidgetRenderProps } from "./types";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (
      key: string,
      values?: { shape?: string; current?: string; next?: string },
    ) => {
      if (values?.shape) {
        return `${key}:${values.shape}`;
      }
      if (values?.current && values.next) {
        return `${key}:${values.current}:${values.next}`;
      }
      return key;
    },
  }),
}));

const baseProps: WidgetRenderProps = {
  instance: { id: "photo-1", type: "photo", x: 0, y: 0, z: 1 },
  onUpdateState: vi.fn(),
};

describe("PhotoWidget", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.open.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows an actionable empty state and imports the selected photo", async () => {
    const onUpdateState = vi.fn();
    mocks.open.mockResolvedValue("/pictures/day.jpg");
    mocks.invoke.mockResolvedValue("/app/home-widget-media/imported.jpg");
    class MockImage {
      naturalWidth = 400;
      naturalHeight = 300;
      onload: HTMLImageElement["onload"] = null;
      onerror: HTMLImageElement["onerror"] = null;

      set src(_value: string) {
        queueMicrotask(() =>
          this.onload?.call(
            this as unknown as GlobalEventHandlers,
            new Event("load"),
          ),
        );
      }
    }
    vi.stubGlobal("Image", MockImage);

    render(<PhotoWidget {...baseProps} onUpdateState={onUpdateState} />);
    fireEvent.click(
      screen.getByRole("button", { name: /widgets\.photo\.addPhoto/i }),
    );

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("import_home_widget_photo", {
        sourcePath: "/pictures/day.jpg",
      });
    });
    await waitFor(() => {
      expect(onUpdateState).toHaveBeenCalledWith({
        path: "/app/home-widget-media/imported.jpg",
        aspectRatio: 4 / 3,
      });
    });
  });

  it.each([
    ["tooLarge", "widgets.photo.tooLarge"],
    ["unsupportedType", "widgets.photo.unsupportedType"],
  ])("shows actionable %s import guidance", async (code, messageKey) => {
    mocks.open.mockResolvedValue("/pictures/day.jpg");
    mocks.invoke.mockRejectedValue({ code });
    const toastSpy = vi.spyOn(toast, "error").mockImplementation(() => "");

    render(<PhotoWidget {...baseProps} />);
    fireEvent.click(
      screen.getByRole("button", { name: /widgets\.photo\.addPhoto/i }),
    );

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(messageKey));
  });

  it("falls back when the imported image probe never completes", async () => {
    vi.useFakeTimers();
    const onUpdateState = vi.fn();
    mocks.open.mockResolvedValue("/pictures/day.jpg");
    mocks.invoke.mockResolvedValue("/app/home-widget-media/imported.jpg");
    class NeverSettlingImage {
      naturalWidth = 0;
      naturalHeight = 0;
      onload: HTMLImageElement["onload"] = null;
      onerror: HTMLImageElement["onerror"] = null;
      src = "";
    }
    vi.stubGlobal("Image", NeverSettlingImage);

    render(<PhotoWidget {...baseProps} onUpdateState={onUpdateState} />);
    fireEvent.click(
      screen.getByRole("button", { name: /widgets\.photo\.addPhoto/i }),
    );

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(onUpdateState).toHaveBeenCalledWith({
      path: "/app/home-widget-media/imported.jpg",
      aspectRatio: 4 / 3,
    });
  });

  it("corrects a fallback aspect ratio when the rendered image loads", () => {
    const onUpdateState = vi.fn();
    render(
      <PhotoWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          state: {
            path: "/app/photo.png",
            shape: "original",
            aspectRatio: 4 / 3,
          },
        }}
        onUpdateState={onUpdateState}
      />,
    );

    const image = screen.getByRole("img");
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 1600 },
      naturalHeight: { configurable: true, value: 900 },
    });
    fireEvent.load(image);

    expect(onUpdateState).toHaveBeenCalledWith({ aspectRatio: 16 / 9 });
  });

  it("renders a managed image and cycles original to square", () => {
    const onUpdateState = vi.fn();
    render(
      <PhotoWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          state: { path: "/app/photo.png", shape: "original" },
        }}
        onUpdateState={onUpdateState}
      />,
    );

    expect(
      screen.getByRole("img", { name: "widgets.photo.imageAlt" }),
    ).toHaveAttribute("src", "asset:///app/photo.png");
    fireEvent.click(
      screen.getByRole("button", {
        name: "widgets.photo.shapeControl:widgets.photo.shapes.original:widgets.photo.shapes.square",
      }),
    );
    expect(onUpdateState).toHaveBeenCalledWith({ shape: "square" });
  });

  it("announces the current and next photo shapes", () => {
    render(
      <PhotoWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          state: { path: "/app/photo.png", shape: "square" },
        }}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "widgets.photo.shapeControl:widgets.photo.shapes.square:widgets.photo.shapes.circle",
      }),
    ).toBeInTheDocument();
  });

  it("offers recovery when the managed image cannot be loaded", async () => {
    const onUpdateState = vi.fn();
    mocks.open.mockResolvedValue("/pictures/replacement.jpg");
    mocks.invoke.mockResolvedValue("/app/home-widget-media/replacement.jpg");
    class MockImage {
      naturalWidth = 800;
      naturalHeight = 600;
      onload: HTMLImageElement["onload"] = null;
      onerror: HTMLImageElement["onerror"] = null;

      set src(_value: string) {
        queueMicrotask(() =>
          this.onload?.call(
            this as unknown as GlobalEventHandlers,
            new Event("load"),
          ),
        );
      }
    }
    vi.stubGlobal("Image", MockImage);

    render(
      <PhotoWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          state: { path: "/app/missing.png", shape: "original" },
        }}
        onUpdateState={onUpdateState}
      />,
    );

    fireEvent.error(screen.getByRole("img"));
    expect(screen.getByText("widgets.photo.unavailable")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: /widgets\.photo\.unavailable.*widgets\.photo\.chooseAnother/i,
      }),
    );

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("import_home_widget_photo", {
        sourcePath: "/pictures/replacement.jpg",
      });
      expect(onUpdateState).toHaveBeenCalledWith({
        path: "/app/home-widget-media/replacement.jpg",
        aspectRatio: 4 / 3,
      });
    });
  });

  it("tries a new persisted path after the previous image was unavailable", () => {
    const { rerender } = render(
      <PhotoWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          state: { path: "/app/missing.png", shape: "original" },
        }}
      />,
    );

    fireEvent.error(screen.getByRole("img"));
    expect(screen.getByText("widgets.photo.unavailable")).toBeInTheDocument();

    rerender(
      <PhotoWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          state: { path: "/app/recovered.png", shape: "original" },
        }}
      />,
    );

    expect(
      screen.getByRole("img", { name: "widgets.photo.imageAlt" }),
    ).toHaveAttribute("src", "asset:///app/recovered.png");
    expect(
      screen.queryByText("widgets.photo.unavailable"),
    ).not.toBeInTheDocument();
  });

  it("ignores child actions while a canvas gesture is active", () => {
    const onUpdateState = vi.fn();
    render(
      <PhotoWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          state: { path: "/app/photo.png", shape: "circle" },
        }}
        onUpdateState={onUpdateState}
        shouldIgnoreActivation={() => true}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "widgets.photo.shapeControl:widgets.photo.shapes.circle:widgets.photo.shapes.original",
      }),
    );
    expect(onUpdateState).not.toHaveBeenCalled();
  });
});
