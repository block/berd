import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PromptEditor } from "./PromptEditor";

describe("PromptEditor", () => {
  it("renders include text without parsing it as HTML", () => {
    const payload = 'include: <img src=x onerror="alert(1)">';
    render(
      <PromptEditor value={payload} onChange={vi.fn()} ariaLabel="Prompt" />,
    );

    const editor = screen.getByRole("textbox", { name: "Prompt" });
    const include = editor.querySelector("span");

    expect(editor.querySelector("img")).toBeNull();
    expect(include).toHaveTextContent(payload);
    expect(include).toHaveClass("bg-info/10");
  });
});
