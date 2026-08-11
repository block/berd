import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsView } from "../SettingsView";

let securityMlEnabled = true;
let voiceConversationEnabled = true;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(0.8),
}));

vi.mock("@/shared/api/acpConnection", () => ({}));

vi.mock("@/shared/profile/capabilities", () => ({
  useProfileCapability: (capability: string) =>
    capability === "voiceConversation" ? voiceConversationEnabled : true,
}));

vi.mock("@/shared/profile/buildProfile", () => ({
  getBuildFeatureState: () => ({ securityMl: securityMlEnabled }),
}));

vi.mock("../ProvidersSettings", () => ({
  ProvidersSettings: () => <div />,
}));

vi.mock("../ModelProviderRow", () => ({
  ModelProviderRow: () => <div />,
}));

vi.mock("../SecuritySettings", () => ({
  SecuritySettings: () => <div>security.title</div>,
}));

vi.mock("@/features/voice-conversation/ui/VoiceSettings", () => ({
  VoiceSettings: () => <div>voice.settings</div>,
}));

// This mock keeps the pane-identity assertions below focused on `SettingsView`'s
// own tree shape. It cannot see inside the real component, so the companion
// guard that the section itself renders no pane lives in
// `ConnectionsSettings.pane.test.tsx`.
vi.mock("@/features/connections/ui/ConnectionsSettings", () => ({
  ConnectionsSettings: () => <div>connections.settings</div>,
}));

function renderSettingsView(
  activeSection: ComponentProps<
    typeof SettingsView
  >["activeSection"] = "security",
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsView activeSection={activeSection} />
    </QueryClientProvider>,
  );
}

describe("SettingsView", () => {
  afterEach(() => {
    securityMlEnabled = true;
    voiceConversationEnabled = true;
  });

  // Rev 3: Security is a permanent section now -- SettingsView no longer
  // gates it on the securityMl build flag. SecuritySettings.tsx gates its
  // own ML rows internally instead, which is out of scope for this mock.
  it("renders security settings regardless of the security ML flag", () => {
    renderSettingsView();

    expect(screen.getByText("security.title")).toBeInTheDocument();

    securityMlEnabled = false;
    renderSettingsView();

    expect(screen.getAllByText("security.title").length).toBeGreaterThan(0);
  });

  it("does not mount native Voice settings when the experiment is off", () => {
    voiceConversationEnabled = false;

    renderSettingsView("voice");

    expect(screen.queryByText("voice.settings")).not.toBeInTheDocument();
  });

  it("renders connections inside the shared settings pane", () => {
    renderSettingsView("connections");

    expect(screen.getByText("connections.settings")).toBeInTheDocument();
  });

  // BOT-1272: `connections` used to early-return its own `SettingsPane`, so
  // switching to/from it made the pane a different component type at the same
  // tree position. React unmounted and remounted the pane, replaying the
  // `page-transition` enter animation (opacity 0 -> 1) and flashing the
  // surface underneath. Every section must render into the same pane element
  // so section switches only swap the pane's children.
  it("keeps the same pane element when switching to and from connections", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // `security` is a mocked section, so this asserts pane identity without
    // dragging in a real section's provider requirements.
    const { container, rerender } = render(
      <QueryClientProvider client={queryClient}>
        <SettingsView activeSection="security" />
      </QueryClientProvider>,
    );

    // Assert on ALL matches, not just the first: a nested second pane would
    // still animate on mount, and `querySelector` alone would not notice it.
    const panesOf = () =>
      Array.from(container.querySelectorAll(".page-transition"));
    const initialPanes = panesOf();
    expect(initialPanes).toHaveLength(1);
    const initialPane = initialPanes[0];

    rerender(
      <QueryClientProvider client={queryClient}>
        <SettingsView activeSection="connections" />
      </QueryClientProvider>,
    );
    expect(screen.getByText("connections.settings")).toBeInTheDocument();
    expect(panesOf()).toEqual([initialPane]);

    rerender(
      <QueryClientProvider client={queryClient}>
        <SettingsView activeSection="security" />
      </QueryClientProvider>,
    );
    expect(screen.getByText("security.title")).toBeInTheDocument();
    expect(panesOf()).toEqual([initialPane]);
  });
});
