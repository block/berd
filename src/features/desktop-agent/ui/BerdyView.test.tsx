import { act, render } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import { BerdyView } from "@/features/desktop-agent/ui/BerdyView";

const instances = vi.hoisted(
  () =>
    [] as {
      start: ReturnType<typeof vi.fn>;
      setTarget: ReturnType<typeof vi.fn>;
      suspend: ReturnType<typeof vi.fn>;
      resume: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
    }[],
);
vi.mock("@/features/desktop-agent/lib/berdyMachine", () => ({
  BerdyMachine: class {
    start = vi.fn();
    setTarget = vi.fn();
    suspend = vi.fn();
    resume = vi.fn();
    dispose = vi.fn();
    constructor() {
      instances.push(this);
    }
  },
}));
beforeEach(() => {
  instances.length = 0;
});
it("recreated machine receives current pose and suspension after reduced-motion toggles", () => {
  let reduced = false;
  let change = () => {};
  vi.spyOn(window, "matchMedia").mockImplementation(
    () =>
      ({
        get matches() {
          return reduced;
        },
        addEventListener: (_: string, cb: () => void) => {
          change = cb;
        },
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );
  const { rerender, unmount } = render(
    <BerdyView target="sit" errored={false} hidden={false} size={92} />,
  );
  expect(instances[0].setTarget).toHaveBeenCalledWith("sit");
  rerender(<BerdyView target="dangle" errored hidden size={92} />);
  expect(instances[0].suspend).toHaveBeenCalled();
  reduced = true;
  act(() => change());
  expect(instances[0].dispose).toHaveBeenCalledOnce();
  reduced = false;
  act(() => change());
  expect(instances[1].setTarget).toHaveBeenCalledWith("dangle");
  expect(instances[1].suspend).toHaveBeenCalled();
  unmount();
  expect(instances[1].dispose).toHaveBeenCalledOnce();
});
