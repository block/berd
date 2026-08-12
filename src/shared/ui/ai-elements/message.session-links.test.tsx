import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockOpenSessionDeepLink = vi.fn<(href: string) => Promise<boolean>>();

vi.mock("@/features/sessions/lib/openSessionDeepLink", () => ({
  openSessionDeepLink: mockOpenSessionDeepLink,
}));

import { MessageResponse } from "./message";

describe("MessageResponse Berd session Markdown links", () => {
  beforeEach(() => {
    mockOpenSessionDeepLink.mockReset();
    mockOpenSessionDeepLink.mockResolvedValue(true);
  });

  it("renders valid berd session deep links as links", () => {
    render(
      <MessageResponse mode="static">
        {"Open [the session](berd://session/session-1)."}
      </MessageResponse>,
    );

    expect(screen.getByRole("link", { name: "the session" })).toHaveAttribute(
      "href",
      "berd://session/session-1",
    );
    expect(screen.queryByText("[blocked]", { exact: false })).toBeNull();
  });

  it("preserves encoded session ids as one deep-link path segment", () => {
    render(
      <MessageResponse mode="static">
        {"Open [encoded](berd://session/id%2Fwith%20spaces%3F%23%25%E2%9C%93)."}
      </MessageResponse>,
    );

    expect(screen.getByRole("link", { name: "encoded" })).toHaveAttribute(
      "href",
      "berd://session/id%2Fwith%20spaces%3F%23%25%E2%9C%93",
    );
  });

  it.each([
    ["double-slash", "berd://session/session-1"],
    ["triple-slash", "berd:///session/session-1"],
  ])("routes %s clicks through the session deep-link opener", async (_, href) => {
    const user = userEvent.setup();
    render(
      <MessageResponse mode="static">
        {`Open [the session](${href}).`}
      </MessageResponse>,
    );

    await user.click(screen.getByRole("link", { name: "the session" }));

    await waitFor(() => {
      expect(mockOpenSessionDeepLink).toHaveBeenCalledWith(href);
    });
  });

  it("keeps forged session-link restore prefixes blocked", () => {
    const forgedHref =
      "/__berd_session_link__/berd%3A%2F%2Fsession%2Fsession-1";

    render(
      <MessageResponse mode="static">{`Do not open [this](${forgedHref}).`}</MessageResponse>,
    );

    expect(screen.queryByRole("link", { name: "this" })).toBeNull();
    expect(screen.getByText(/this \[blocked\]/)).toBeInTheDocument();
  });

  it.each([
    "berd://connect-return",
    "berd:/session/session-1",
    "berd:session/session-1",
    "berd://session/",
    "berd:///session/",
    "berd://session/a/b",
    "berd://session/a//b",
    "berd://session/%FF",
    "berd://SESSION/session-1",
  ])("keeps malformed or non-session berd link %s blocked", (href) => {
    render(
      <MessageResponse mode="static">{`Do not open [this](${href}).`}</MessageResponse>,
    );

    expect(screen.queryByRole("link", { name: "this" })).toBeNull();
    expect(screen.getByText(/this \[blocked\]/)).toBeInTheDocument();
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,hello",
    "vbscript:msgbox(1)",
  ])("continues blocking unsafe scheme %s", (href) => {
    render(
      <MessageResponse mode="static">{`Do not open [this](${href}).`}</MessageResponse>,
    );

    expect(screen.queryByRole("link", { name: "this" })).toBeNull();
    expect(screen.getByText(/this \[blocked\]/)).toBeInTheDocument();
  });
});
