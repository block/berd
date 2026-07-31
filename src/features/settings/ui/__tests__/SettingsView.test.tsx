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

  it("renders security settings when security ML is enabled", () => {
    renderSettingsView();

    expect(screen.getByText("security.title")).toBeInTheDocument();
  });

  it("does not render security settings when security ML is disabled", () => {
    securityMlEnabled = false;

    renderSettingsView();

    expect(screen.queryByText("security.title")).not.toBeInTheDocument();
  });

  it("does not mount native Voice settings when the experiment is off", () => {
    voiceConversationEnabled = false;

    renderSettingsView("voice");

    expect(screen.queryByText("voice.settings")).not.toBeInTheDocument();
  });
});
