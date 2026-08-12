import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/updates/ui/BetaBadge", () => ({
  BetaBadge: () => null,
}));

import { TopBar } from "@/app/ui/TopBar";

// Mirrors the semantics of Tauri's injected drag script
// (tauri 2.11.x src/window/scripts/drag.js): a bare
// `data-tauri-drag-region` only starts a drag when the pressed element
// itself carries the attribute; "deep" covers the subtree; clickable
// elements block dragging unless they opt in themselves.
const CLICKABLE_TAGS = new Set([
  "A",
  "BUTTON",
  "INPUT",
  "SELECT",
  "TEXTAREA",
  "LABEL",
  "SUMMARY",
]);
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "tab",
  "checkbox",
  "radio",
  "switch",
  "option",
]);

function isClickableElement(el: HTMLElement): boolean {
  return (
    CLICKABLE_TAGS.has(el.tagName) ||
    (el.hasAttribute("contenteditable") &&
      el.getAttribute("contenteditable") !== "false") ||
    (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1") ||
    INTERACTIVE_ROLES.has(el.getAttribute("role") ?? "")
  );
}

function wouldStartWindowDrag(target: HTMLElement): boolean {
  const path: HTMLElement[] = [];
  let node: HTMLElement | null = target;
  while (node) {
    path.push(node);
    node = node.parentElement;
  }
  for (const el of path) {
    const attr = el.getAttribute("data-tauri-drag-region");
    if (isClickableElement(el) && attr === null) return false;
    if (attr === null) continue;
    if (attr === "false") return false;
    if (attr === "deep") return true;
    if (attr === "" || attr === "true") return el === path[0];
  }
  return false;
}

function renderTopBar() {
  const { container } = render(
    <TopBar
      breadcrumbs={[{ id: "chat-session", label: "Navigation follow-ups" }]}
      canGoBack
      canGoForward
      onGoBack={() => {}}
      onGoForward={() => {}}
      onToggleSidebar={() => {}}
      onSearchClick={() => {}}
      onFeedbackClick={() => {}}
    />,
  );
  const header = container.querySelector("header");
  if (!header) throw new Error("TopBar header not rendered");
  return header;
}

describe("TopBar window drag coverage", () => {
  it("every non-interactive surface in the top bar is draggable", () => {
    const header = renderTopBar();
    const deadZones: string[] = [];
    const all = [header, ...header.querySelectorAll<HTMLElement>("*")];
    for (const el of all) {
      // Interactive controls (and their icon contents) are expected to
      // block dragging.
      if (el.closest("button, a, input, select, textarea, label")) continue;
      if (!wouldStartWindowDrag(el)) {
        deadZones.push(
          `<${el.tagName.toLowerCase()} class="${el.getAttribute("class") ?? ""}">`,
        );
      }
    }
    expect(deadZones).toEqual([]);
  });
});
