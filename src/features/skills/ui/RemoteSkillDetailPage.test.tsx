import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteSkill } from "../api/skillMarketplace";

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
});
