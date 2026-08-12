import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteSkill } from "../api/skillMarketplace";
import { useDistroStore } from "@/features/settings/stores/distroStore";

const mocks = vi.hoisted(() => ({
  showRemoteSkill: vi.fn<(name: string) => Promise<string>>(),
  openSessionDeepLink: vi.fn<(href: string) => Promise<boolean>>(),
}));

vi.mock("../api/skillMarketplace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/skillMarketplace")>()),
  showRemoteSkill: mocks.showRemoteSkill,
}));

vi.mock("@/features/sessions/lib/openSessionDeepLink", () => ({
  openSessionDeepLink: mocks.openSessionDeepLink,
}));

import { RemoteSkillDetailPage } from "../ui/RemoteSkillDetailPage";

const remoteSkill: RemoteSkill = {
  name: "remote-skill",
  description: "Preview a remote skill",
  roles: [],
  references: [],
  author: null,
  status: null,
  installed: false,
};

describe("RemoteSkillDetailPage session links", () => {
  beforeEach(() => {
    mocks.showRemoteSkill.mockReset();
    mocks.openSessionDeepLink.mockReset();
    mocks.openSessionDeepLink.mockResolvedValue(true);
    vi.mocked(openUrl).mockReset();
    useDistroStore.setState({
      loaded: true,
      manifest: { present: false, kgooseConfigured: false },
    });
  });

  it("renders remote-skill Berd session links with the shared security boundary", async () => {
    const user = userEvent.setup();
    mocks.showRemoteSkill.mockResolvedValue(
      [
        "Open [valid](berd://session/session-1).",
        "Do not open [single slash](berd:/session/session-1).",
        "Do not open [script](javascript:alert(1)).",
      ].join("\n\n"),
    );

    render(
      <RemoteSkillDetailPage
        skill={remoteSkill}
        installing={false}
        onInstall={vi.fn()}
      />,
    );

    const valid = await screen.findByRole("link", { name: "valid" });
    expect(valid).toHaveAttribute("href", "berd://session/session-1");
    expect(screen.queryByRole("link", { name: "single slash" })).toBeNull();
    expect(screen.getByText(/single slash \[blocked\]/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "script" })).toBeNull();
    expect(screen.getByText(/script \[blocked\]/)).toBeInTheDocument();

    await user.click(valid);

    await waitFor(() => {
      expect(mocks.openSessionDeepLink).toHaveBeenCalledWith(
        "berd://session/session-1",
      );
    });
  });
  it("omits only the web action when no marketplace template is configured", async () => {
    mocks.showRemoteSkill.mockResolvedValue("Remote instructions");

    render(
      <RemoteSkillDetailPage
        skill={remoteSkill}
        installing={false}
        onInstall={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "View on web" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install" })).toBeInTheDocument();
    expect(await screen.findByText("Remote instructions")).toBeInTheDocument();
  });

  it("opens the configured marketplace URL", async () => {
    const user = userEvent.setup();
    mocks.showRemoteSkill.mockResolvedValue("Remote instructions");
    useDistroStore.setState({
      loaded: true,
      manifest: {
        present: true,
        kgooseConfigured: false,
        marketplace: {
          skillUrlTemplate:
            "https://marketplace.example.test/skill?id={skillId}",
        },
      },
    });

    render(
      <RemoteSkillDetailPage
        skill={{ ...remoteSkill, name: "skill with spaces" }}
        installing={false}
        onInstall={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "View on web" }));

    await waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith(
        "https://marketplace.example.test/skill?id=skill%20with%20spaces",
      );
    });
  });
});
