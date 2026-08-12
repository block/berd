import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConnectionsSettings } from "./ConnectionsSettings";

/**
 * BOT-1272 guard, on the real component.
 *
 * `SettingsView` renders `ConnectionsSettings` into the one shared
 * `SettingsPane` that every settings section uses. `SettingsPane` carries
 * `.page-transition`, which starts at `opacity: 0` and animates in over 160ms.
 * If `ConnectionsSettings` ever supplies its own pane again, switching to or
 * from Connections replays that enter animation and flashes the surface
 * underneath.
 *
 * The sibling assertion in `SettingsView.test.tsx` mocks this module, so it
 * cannot see inside it. This test renders the real component so re-adding a
 * pane here fails CI instead of silently reintroducing the flash.
 */

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tauri-apps/plugin-deep-link", () => ({
  onOpenUrl: () => Promise.resolve(() => {}),
}));

vi.mock("@/features/extensions/hooks/useExtensionsSettings", () => ({
  useExtensionsSettings: () => ({
    extensions: [],
    isLoading: false,
    modalMode: null,
    editingExtension: null,
    handleAdd: () => {},
    handleConfigure: () => {},
    handleSubmit: () => {},
    handleDelete: () => {},
    handleReset: () => {},
    handleModalClose: () => {},
  }),
}));

// Off keeps the OAuth catalog query out of this test; the pane contract is
// independent of which connection rows render.
vi.mock("@/shared/profile/capabilities", () => ({
  useProfileCapability: () => false,
}));

function renderConnectionsSettings() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ConnectionsSettings />
    </QueryClientProvider>,
  );
}

describe("ConnectionsSettings", () => {
  it("renders no page wrapper so the caller owns the settings pane", () => {
    const { container } = renderConnectionsSettings();

    expect(container.querySelectorAll(".page-transition")).toHaveLength(0);
  });

  it("renders its own content spacing", () => {
    const { container } = renderConnectionsSettings();

    expect(container.firstElementChild).toHaveClass("flex", "flex-col");
  });
});
