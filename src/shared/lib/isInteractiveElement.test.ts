import { describe, it, expect, afterEach } from "vitest";
import { isInteractiveElement } from "./isInteractiveElement";

function render(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

describe("isInteractiveElement", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("returns false for non-Element targets", () => {
    expect(isInteractiveElement(null)).toBe(false);
    expect(isInteractiveElement(document)).toBe(false);
  });

  it("matches native form and link controls", () => {
    const host = render(
      `<a href="#">a</a><button>b</button><input /><select></select>
       <textarea></textarea><label>l</label><summary>s</summary>`,
    );
    for (const el of Array.from(host.children)) {
      expect(isInteractiveElement(el)).toBe(true);
    }
  });

  it("matches a click on a descendant of an interactive control", () => {
    const host = render(`<button><span>icon</span></button>`);
    const span = host.querySelector("span");
    expect(isInteractiveElement(span)).toBe(true);
  });

  it("matches contenteditable regardless of value form", () => {
    const host = render(
      `<div contenteditable></div><div contenteditable="true"></div>`,
    );
    for (const el of Array.from(host.children)) {
      expect(isInteractiveElement(el)).toBe(true);
    }
  });

  it("matches ARIA widget roles the old allowlist missed", () => {
    const roles = [
      "option",
      "combobox",
      "tab",
      "checkbox",
      "radio",
      "switch",
      "slider",
      "menuitemcheckbox",
    ];
    for (const role of roles) {
      const host = render(`<div role="${role}"></div>`);
      expect(isInteractiveElement(host.firstElementChild)).toBe(true);
    }
  });

  it("honors the data-interactive escape hatch", () => {
    const host = render(
      `<div data-interactive></div>
       <div data-interactive="true"></div>
       <div data-interactive="false"></div>`,
    );
    const [present, explicitTrue, explicitFalse] = Array.from(host.children);
    expect(isInteractiveElement(present)).toBe(true);
    expect(isInteractiveElement(explicitTrue)).toBe(true);
    expect(isInteractiveElement(explicitFalse)).toBe(false);
  });

  it("returns false for plain non-interactive content", () => {
    const host = render(`<div><span>plain text</span></div>`);
    expect(isInteractiveElement(host.querySelector("span"))).toBe(false);
  });
});
