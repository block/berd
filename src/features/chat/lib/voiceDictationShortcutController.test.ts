import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("@/shared/lib/platform", () => ({ getPlatform: () => "mac" }));

import {
  resetShortcutOverride,
  setShortcutOverride,
} from "@/features/shortcuts/lib/shortcutRegistry";
import {
  resetVoiceDictationShortcutControllerForTests,
  useVoiceDictationShortcutTarget,
  type VoiceDictationShortcutSurface,
} from "./voiceDictationShortcutController";

function textarea() {
  const element = document.createElement("textarea");
  element.getBoundingClientRect = () => ({ width: 200, height: 30 }) as DOMRect;
  document.body.append(element);
  return element;
}

function register(
  surface: VoiceDictationShortcutSurface,
  options: { canStart?: boolean; isRecording?: boolean } = {},
) {
  const element = textarea();
  const toggle = vi.fn();
  const ref = { current: element };
  const { rerender, unmount } = renderHook(
    (state) => useVoiceDictationShortcutTarget(ref, state),
    {
      initialProps: {
        surface,
        canStart: options.canStart ?? true,
        isRecording: options.isRecording ?? false,
        toggle,
      },
    },
  );
  return { element, toggle, rerender, unmount };
}

function press(target: EventTarget = window, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "d",
    code: "KeyD",
    metaKey: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  resetVoiceDictationShortcutControllerForTests();
  resetShortcutOverride("chat.toggleVoiceDictation");
  document.body.replaceChildren();
});

describe("voice dictation shortcut controller", () => {
  it("routes by recording priority, then centered global, selected chat, and home global", () => {
    const home = register("home-global");
    const selected = register("selected-chat");
    const centered = register("centered-global");

    press();
    expect(centered.toggle).toHaveBeenCalledOnce();

    home.rerender({
      surface: "home-global",
      canStart: false,
      isRecording: true,
      toggle: home.toggle,
    });
    press();
    expect(home.toggle).toHaveBeenCalledOnce();
    expect(selected.toggle).not.toHaveBeenCalled();
  });

  it("ignores hidden or unavailable starts but allows an active recording to stop", () => {
    const hidden = register("centered-global");
    hidden.element.hidden = true;
    const unavailable = register("selected-chat", { canStart: false });
    const recording = register("home-global", {
      canStart: false,
      isRecording: true,
    });

    press();
    expect(hidden.toggle).not.toHaveBeenCalled();
    expect(unavailable.toggle).not.toHaveBeenCalled();
    expect(recording.toggle).toHaveBeenCalledOnce();
  });

  it.each([
    ["input", () => document.createElement("input")],
    [
      "terminal",
      () =>
        Object.assign(document.createElement("div"), { className: "xterm" }),
    ],
    [
      "shortcut recorder",
      () => {
        const element = document.createElement("button");
        element.dataset.shortcutRecording = "true";
        return element;
      },
    ],
  ])("does not steal from a %s", (_label, createTarget) => {
    const target = register("selected-chat");
    const owner = createTarget();
    document.body.append(owner);

    expect(press(owner).defaultPrevented).toBe(false);
    expect(target.toggle).not.toHaveBeenCalled();
  });

  it("stands down for keyboard-owning layers and invalid key events", () => {
    const target = register("selected-chat");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    press();
    dialog.remove();
    press(window, { repeat: true });
    press(window, { isComposing: true });

    expect(target.toggle).not.toHaveBeenCalled();
  });

  it("matches custom bindings, focuses before toggling, and owns handled events", () => {
    expect(setShortcutOverride("chat.toggleVoiceDictation", "alt+d")).toEqual({
      ok: true,
    });
    const order: string[] = [];
    const target = register("selected-chat");
    target.element.focus = vi.fn(() => order.push("focus"));
    target.toggle.mockImplementation(() => order.push("toggle"));
    const laterListener = vi.fn();
    window.addEventListener("keydown", laterListener);

    expect(press().defaultPrevented).toBe(false);
    const handled = press(window, { metaKey: false, altKey: true });

    expect(handled.defaultPrevented).toBe(true);
    expect(order).toEqual(["focus", "toggle"]);
    expect(laterListener).toHaveBeenCalledOnce();
    window.removeEventListener("keydown", laterListener);
  });

  it("handles shortcuts before an intermediate control stops bubbling", () => {
    const target = register("selected-chat");
    const control = document.createElement("button");
    control.addEventListener("keydown", (event) => event.stopPropagation());
    document.body.append(control);

    expect(press(control).defaultPrevented).toBe(true);
    expect(target.toggle).toHaveBeenCalledOnce();
  });

  it("keeps focused registered textareas on the local fast path and cleans up", () => {
    const target = register("selected-chat");
    target.element.addEventListener("keydown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      target.toggle();
    });

    press(target.element);
    expect(target.toggle).toHaveBeenCalledOnce();

    target.unmount();
    press();
    expect(target.toggle).toHaveBeenCalledOnce();
  });
});
