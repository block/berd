import { render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGooseContextLimit } from "../../useGooseContextLimit";
import { GooseContextLimitSettings } from "../GooseContextLimitSettings";

const { read, upsert } = vi.hoisted(() => ({ read: vi.fn(), upsert: vi.fn() }));
vi.mock("@/shared/api/acpConnection", () => ({
  getClient: async () => ({
    goose: { GooseUnstableConfigRead: read, GooseUnstableConfigUpsert: upsert },
  }),
}));

describe("Goose context settings persistence and readback", () => {
  beforeEach(() => {
    read.mockReset().mockResolvedValue({ value: 272_000 });
    upsert.mockReset().mockResolvedValue(undefined);
  });

  it("keeps a successful save in the UI and other controls while readback retries", async () => {
    const user = userEvent.setup();
    const otherControl = renderHook(() => useGooseContextLimit());
    render(<GooseContextLimitSettings />);
    const input = screen.getByRole("spinbutton", {
      name: "Max context tokens",
    });
    await waitFor(() => expect(input).toBeEnabled());
    read.mockRejectedValue(new Error("readback unavailable"));

    await user.clear(input);
    await user.type(input, "450000");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("status")).toHaveTextContent("was saved");
    expect(input).toHaveValue(450_000);
    expect(otherControl.result.current.contextLimit).toBe(450_000);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(upsert).toHaveBeenCalledTimes(1);

    // Retrying only the read reconciles an environment override, without
    // submitting the write a second time or reporting a false save failure.
    read.mockResolvedValue({ value: 128_000 });
    await waitFor(() => expect(input).toHaveValue(128_000), { timeout: 2500 });
    expect(otherControl.result.current.contextLimit).toBe(128_000);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
