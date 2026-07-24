import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

import { openSessionDeepLink } from "./openSessionDeepLink";

describe("openSessionDeepLink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches valid session links through the existing session open command", async () => {
    const dispatch = vi.fn().mockResolvedValue({ ok: true });

    await expect(
      openSessionDeepLink("berd://session/session-1", dispatch),
    ).resolves.toBe(true);

    expect(dispatch).toHaveBeenCalledWith(
      "sessions",
      { action: "open", session_id: "session-1" },
      {},
    );
  });

  it("percent-decodes the session id before dispatching", async () => {
    const dispatch = vi.fn().mockResolvedValue({ ok: true });

    await openSessionDeepLink(
      "berd://session/id%2Fwith%20spaces%3F%23%25%E2%9C%93",
      dispatch,
    );

    expect(dispatch).toHaveBeenCalledWith(
      "sessions",
      { action: "open", session_id: "id/with spaces?#%✓" },
      {},
    );
  });

  it.each([
    "berd://connect-return",
    "berd:/session/session-1",
    "berd:session/session-1",
    "berd://session/",
    "berd:///session/",
    "berd://session/a/b",
    "berd://session/%FF",
    "berd://SESSION/session-1",
    "javascript:alert(1)",
    "https://example.com",
  ])("ignores non-session links without dispatching %s", async (href) => {
    const dispatch = vi.fn().mockResolvedValue({ ok: true });

    await expect(openSessionDeepLink(href, dispatch)).resolves.toBe(false);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("shows dispatch failures as a toast after handling the link", async () => {
    const dispatch = vi.fn().mockRejectedValue(new Error("No session."));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      openSessionDeepLink("berd://session/missing-session", dispatch),
    ).resolves.toBe(true);

    expect(toast.error).toHaveBeenCalledWith("No session.");
    error.mockRestore();
  });
});
