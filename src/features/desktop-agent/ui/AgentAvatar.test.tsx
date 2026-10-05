import { act, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { DEFAULT_AVATAR } from "@/features/desktop-agent/lib/avatarState";
import { AgentAvatar } from "@/features/desktop-agent/ui/AgentAvatar";

const callbacks = vi.hoisted(() => ({ chip: () => {}, berdy: () => {} }));
vi.mock("@/features/desktop-agent/ui/AvatarView", () => ({
  AvatarView: ({ onReady }: { onReady: () => void }) => {
    callbacks.chip = onReady;
    return <span data-testid="chip" />;
  },
}));
vi.mock("@/features/desktop-agent/ui/BerdyView", () => ({
  BerdyView: ({ onReady }: { onReady: () => void }) => {
    callbacks.berdy = onReady;
    return <span data-testid="berdy" />;
  },
}));
it("retains outgoing renderer until incoming pixels and cancels superseded switches", () => {
  const view = (character: boolean) => (
    <AgentAvatar
      character={character}
      choice={DEFAULT_AVATAR}
      state="idle"
      target="idle"
      hidden={false}
    />
  );
  const { rerender, queryByTestId, getByTestId } = render(view(false));
  rerender(view(true));
  expect(getByTestId("chip").parentElement).toHaveStyle({ opacity: "1" });
  expect(getByTestId("berdy").parentElement).toHaveStyle({ opacity: "0" });
  rerender(view(false));
  expect(queryByTestId("berdy")).toBeNull();
  rerender(view(true));
  act(() => callbacks.berdy());
  expect(queryByTestId("chip")).toBeNull();
  rerender(view(false));
  expect(getByTestId("berdy").parentElement).toHaveStyle({ opacity: "1" });
  act(() => callbacks.chip());
  expect(queryByTestId("berdy")).toBeNull();
});

it("initial character enablement presents the fallback chip until real character pixels", () => {
  const { getByTestId, queryByTestId } = render(
    <AgentAvatar
      character
      choice={DEFAULT_AVATAR}
      state="idle"
      target="idle"
      hidden={false}
    />,
  );
  expect(getByTestId("chip").parentElement).toHaveStyle({ opacity: "1" });
  expect(getByTestId("berdy").parentElement).toHaveStyle({ opacity: "0" });
  act(() => callbacks.chip());
  expect(getByTestId("chip").parentElement).toHaveStyle({ opacity: "1" });
  act(() => callbacks.berdy());
  expect(queryByTestId("chip")).toBeNull();
  expect(getByTestId("berdy").parentElement).toHaveStyle({ opacity: "1" });
});
