import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsView } from "../SettingsView";

let securityMlEnabled = true;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(0.8),
}));

vi.mock("@/shared/api/acpConnection", () => ({}));

vi.mock("@/shared/profile/capabilities", () => ({
  useProfileCapability: () => true,
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

function renderSettingsView() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsView
        activeSection="security"
        activeConnectionsTab="companyManaged"
        onConnectionsTabChange={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe("SettingsView", () => {
  afterEach(() => {
    securityMlEnabled = true;
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
});
