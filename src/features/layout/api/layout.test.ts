import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOME_LAYOUT_ID,
  getLayout,
  resetLayout,
  saveLayoutCamera,
  saveLayoutItems,
  type Layout,
  type SaveLayoutItemsRequest,
} from "./layout";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);

const layout: Layout = {
  layoutId: HOME_LAYOUT_ID,
  itemRevision: 1,
  cameraRevision: 2,
  camera: {
    centerX: 0,
    centerY: 0,
    zoomBps: 10_000,
  },
  items: [],
  constraints: {
    minCenter: -1_000_000,
    maxCenter: 1_000_000,
    minSize: 1,
    maxSize: 100_000,
    minZoomBps: 1_000,
    maxZoomBps: 80_000,
    maxTitleOverrideLength: 200,
    maxItems: 500,
  },
};

describe("layout API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("gets the layout through Tauri", async () => {
    mockedInvoke.mockResolvedValue(layout);

    await expect(getLayout(HOME_LAYOUT_ID)).resolves.toBe(layout);

    expect(mockedInvoke).toHaveBeenCalledWith("get_layout", {
      layoutId: HOME_LAYOUT_ID,
    });
  });

  it("saves layout items through Tauri", async () => {
    const result = { ok: true, layout } as const;
    const request: SaveLayoutItemsRequest = {
      layoutId: HOME_LAYOUT_ID,
      expectedRevision: 1,
      replaceKinds: ["session"],
      items: [
        {
          id: "00000000-0000-0000-0000-000000000001",
          kind: "session" as const,
          targetId: "session-1",
          centerX: 0,
          centerY: 0,
          width: 100,
          height: 80,
          zIndex: 1,
          titleOverride: null,
        },
      ],
    };
    mockedInvoke.mockResolvedValue(result);

    await expect(saveLayoutItems(request)).resolves.toBe(result);

    expect(mockedInvoke).toHaveBeenCalledWith("save_layout_items", { request });
  });

  it("saves layout camera through Tauri", async () => {
    const result = { ok: true, layout } as const;
    const request = {
      layoutId: HOME_LAYOUT_ID,
      expectedRevision: 2,
      camera: {
        centerX: 12,
        centerY: 24,
        zoomBps: 12_000,
      },
    };
    mockedInvoke.mockResolvedValue(result);

    await expect(saveLayoutCamera(request)).resolves.toBe(result);

    expect(mockedInvoke).toHaveBeenCalledWith("save_layout_camera", {
      request,
    });
  });

  it("resets layout through Tauri", async () => {
    const result = { ok: true, layout } as const;
    const request = {
      layoutId: HOME_LAYOUT_ID,
      expectedItemRevision: 1,
      expectedCameraRevision: 2,
    };
    mockedInvoke.mockResolvedValue(result);

    await expect(resetLayout(request)).resolves.toBe(result);

    expect(mockedInvoke).toHaveBeenCalledWith("reset_layout", { request });
  });

  it("returns revision conflicts as typed mutation results", async () => {
    const result = {
      ok: false,
      reason: "revisionConflict",
      layout,
    } as const;
    mockedInvoke.mockResolvedValue(result);

    const response = await saveLayoutCamera({
      layoutId: HOME_LAYOUT_ID,
      expectedRevision: 1,
      camera: layout.camera,
    });

    expect(response).toBe(result);
    if (!response.ok) {
      expect(response.reason).toBe("revisionConflict");
      expect(response.layout).toBe(layout);
    }
  });
});
