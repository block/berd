import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { renderWithProviders } from "@/test/render";
import type { Persona } from "@/shared/types/agents";
import { PersonaEditor } from "../PersonaEditor";

type User = ReturnType<typeof userEvent.setup>;

vi.mock("@/shared/api/acp", () => ({
  discoverAcpProviders: vi.fn(async () => []),
}));

vi.mock("@/features/providers/api/inventory", () => ({
  getProviderInventory: vi.fn(async () => []),
}));

vi.mock("@/shared/hooks/useAvatarSrc", () => ({
  useAvatarMediaState: vi.fn(() => ({
    media: null,
    loading: false,
    unavailable: false,
    retry: vi.fn(),
  })),
}));

const avatarApiMocks = vi.hoisted(() => {
  const catalog = {
    schemaVersion: 1 as const,
    catalogVersion: "v1",
    collections: [
      {
        id: "gloopies",
        label: "Gloopies",
        coverAvatarId: "gloopy-1",
        avatarIds: ["gloopy-1"],
      },
    ],
    assets: [
      {
        id: "gloopy-1",
        label: "Gloopy 1",
        collectionId: "gloopies",
        variants: {
          webm: {
            path: "webm/gloopies/gloopy-1.webm",
            mimeType: "video/webm",
            byteSize: 100,
            sha256: "a".repeat(64),
          },
          hevc: {
            path: "hevc/gloopies/gloopy-1.mp4",
            mimeType: "video/mp4",
            byteSize: 100,
            sha256: "b".repeat(64),
          },
        },
      },
    ],
  };
  const cachedCollection = {
    catalogVersion: "v1",
    collectionId: "gloopies",
    failedAssetIds: [] as string[],
    assets: [
      {
        id: "gloopy-1",
        path: "/tmp/goose/avatars/v1/webm/gloopies/gloopy-1.webm",
        mimeType: "video/webm",
      },
    ],
  };

  return {
    cachedCollection,
    catalog,
    ensureAvatarCollection: vi.fn(async () => cachedCollection),
    ensureAvatarForRef: vi.fn(async () => ({
      catalogVersion: "v1",
      collectionId: "gloopies",
      asset: cachedCollection.assets[0],
    })),
    getAvatarCatalog: vi.fn(async () => catalog),
    getCachedAvatarCollections: vi.fn(async () => []),
  };
});

vi.mock("@/shared/api/avatars", () => ({
  cachedAssetToMedia: (asset: { path: string; mimeType: string }) => ({
    src: `asset://${asset.path}`,
    mediaType: asset.mimeType.startsWith("video/") ? "video" : "image",
  }),
  ensureAvatarCollection: avatarApiMocks.ensureAvatarCollection,
  ensureAvatarForRef: avatarApiMocks.ensureAvatarForRef,
  getAvatarCatalog: avatarApiMocks.getAvatarCatalog,
  getCachedAvatarCollections: avatarApiMocks.getCachedAvatarCollections,
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

function renderEditor(
  props: Partial<ComponentProps<typeof PersonaEditor>> = {},
) {
  const user = userEvent.setup();
  const onSave = vi.fn();
  const onClose = vi.fn();
  const view = renderWithProviders(
    <PersonaEditor isOpen onClose={onClose} onSave={onSave} {...props} />,
  );

  return { ...view, onClose, onSave, user };
}

async function fillDisplayName(user: User) {
  await user.type(screen.getByPlaceholderText("e.g. Code Reviewer"), "Scout");
}

async function fillSystemPrompt(user: User) {
  await user.type(
    screen.getByPlaceholderText("Describe the agent's goal and instructions"),
    "Research.",
  );
}

async function fillRequiredFields(user: User) {
  await fillDisplayName(user);
  await fillSystemPrompt(user);
}

async function submitCreate(user: User) {
  await fillRequiredFields(user);
  await user.click(screen.getByRole("button", { name: /^create$/i }));
}

describe("PersonaEditor", () => {
  beforeEach(() => {
    avatarApiMocks.ensureAvatarCollection.mockClear();
    avatarApiMocks.ensureAvatarCollection.mockResolvedValue(
      avatarApiMocks.cachedCollection,
    );
    avatarApiMocks.ensureAvatarForRef.mockClear();
    avatarApiMocks.getAvatarCatalog.mockClear();
    avatarApiMocks.getCachedAvatarCollections.mockClear();
    avatarApiMocks.getAvatarCatalog.mockResolvedValue(avatarApiMocks.catalog);
    avatarApiMocks.getCachedAvatarCollections.mockResolvedValue([]);
  });

  it.each([
    {
      name: "omits avatar for new personas without a custom URL",
      avatar: undefined,
    },
    {
      name: "saves a custom avatar URL for new personas",
      avatar: "https://example.test/custom.png",
      arrange: async (user: User) => {
        await user.type(
          screen.getByLabelText(/custom avatar url/i),
          "https://example.test/custom.png",
        );
      },
    },
    {
      name: "saves a bundled avatar for new personas",
      avatar: "app-avatar:gloopy-1",
      arrange: async (user: User) => {
        await user.click(
          await screen.findByRole("button", { name: /gloopies/i }),
        );
        await user.click(
          await screen.findByRole("button", { name: /^gloopy 1$/i }),
        );
      },
    },
  ])("$name", async ({ arrange, avatar }) => {
    const { onSave, user } = renderEditor();

    await arrange?.(user);
    await submitCreate(user);

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        avatar,
        displayName: "Scout",
        systemPrompt: "Research.",
      }),
    );
  });

  it("downloads avatar collections with the loaded catalog version", async () => {
    const { user } = renderEditor();

    await user.click(await screen.findByRole("button", { name: /gloopies/i }));

    expect(avatarApiMocks.ensureAvatarCollection).toHaveBeenCalledWith({
      catalogVersion: "v1",
      collectionId: "gloopies",
    });
  });

  it("shows partial avatar collection failures and retries them", async () => {
    avatarApiMocks.ensureAvatarCollection
      .mockResolvedValueOnce({
        ...avatarApiMocks.cachedCollection,
        assets: [],
        failedAssetIds: ["gloopy-1"],
      })
      .mockResolvedValueOnce({
        ...avatarApiMocks.cachedCollection,
        failedAssetIds: [],
      });
    const { user } = renderEditor();

    await user.click(await screen.findByRole("button", { name: /gloopies/i }));
    expect(await screen.findByText(/failed to load/i)).toBeVisible();

    await user.click(screen.getByRole("button", { name: /retry/i }));

    await waitFor(() =>
      expect(screen.queryByText(/failed to load/i)).not.toBeInTheDocument(),
    );
    expect(avatarApiMocks.ensureAvatarCollection).toHaveBeenCalledTimes(2);
  });

  it("does not allow selecting an asset that failed to cache", async () => {
    avatarApiMocks.ensureAvatarCollection.mockResolvedValueOnce({
      ...avatarApiMocks.cachedCollection,
      assets: [],
      failedAssetIds: ["gloopy-1"],
    });
    const { user } = renderEditor();

    await user.click(await screen.findByRole("button", { name: /gloopies/i }));

    expect(
      await screen.findByRole("button", { name: /^gloopy 1$/i }),
    ).toBeDisabled();
  });

  it("blocks saving bundled avatar refs until catalog validation completes", async () => {
    let resolveCatalog!: (value: typeof avatarApiMocks.catalog) => void;
    avatarApiMocks.getAvatarCatalog.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCatalog = resolve;
      }),
    );

    const { onSave, user } = renderEditor({
      mode: "edit",
      persona: makePersona({
        avatar: "app-avatar:missing",
        sourceProperties: { avatar: "app-avatar:missing" },
      }),
    });

    expect(
      screen.getByRole("button", { name: /save changes/i }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /save changes/i }));
    expect(onSave).not.toHaveBeenCalled();

    resolveCatalog(avatarApiMocks.catalog);
  });

  it("blocks saving unknown bundled avatar refs from the loaded catalog", async () => {
    const { onSave, user } = renderEditor({
      mode: "edit",
      persona: makePersona({
        avatar: "app-avatar:missing",
        sourceProperties: { avatar: "app-avatar:missing" },
      }),
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /save changes/i }),
      ).toBeDisabled(),
    );
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(onSave).not.toHaveBeenCalled();
  });

  it("does not download saved bundled avatar refs while rendering", async () => {
    renderEditor({
      mode: "edit",
      persona: makePersona({
        avatar: "app-avatar:gloopy-1",
        sourceProperties: { avatar: "app-avatar:gloopy-1" },
      }),
    });

    await screen.findByRole("button", { name: /gloopies/i });

    expect(avatarApiMocks.ensureAvatarForRef).not.toHaveBeenCalled();
  });

  it("does not submit an unchanged avatar while editing", async () => {
    const { onSave, user } = renderEditor({
      mode: "edit",
      persona: makePersona(),
    });

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        avatar: undefined,
      }),
    );
  });

  it("preserves non-url avatar sources when the open editor switches personas", async () => {
    const { onSave, rerender, user } = renderEditor({
      mode: "edit",
      persona: makePersona(),
    });

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
    const { onSave, user } = renderEditor({
      mode: "edit",
      persona: makePersona(),
    });

    await user.clear(screen.getByLabelText(/custom avatar url/i));
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        avatar: null,
      }),
    );
  });
});
