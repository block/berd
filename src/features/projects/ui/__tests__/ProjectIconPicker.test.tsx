import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PROJECT_ICON } from "../../lib/projectIcons";
import { ProjectIconPicker } from "../ProjectIconPicker";

describe("ProjectIconPicker", () => {
  it("offers color block, scanned repo icons, and upload without preset icons", async () => {
    const user = userEvent.setup();
    const onChooseIcon = vi.fn();
    const onChooseCustomIcon = vi.fn();

    render(
      <ProjectIconPicker
        icon={DEFAULT_PROJECT_ICON}
        color="olive"
        iconCandidates={[
          {
            id: "/repo/public/logo.svg",
            label: "public/logo.svg",
            icon: "data:image/svg+xml;base64,bG9nbw==",
            sourceDir: "repo",
          },
        ]}
        onChooseIcon={onChooseIcon}
        onChooseCustomIcon={onChooseCustomIcon}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Icon Color block" }));
    expect(onChooseIcon).toHaveBeenCalledWith(DEFAULT_PROJECT_ICON);

    await user.click(
      screen.getByRole("button", { name: "Icon public/logo.svg" }),
    );
    expect(onChooseIcon).toHaveBeenCalledWith(
      "data:image/svg+xml;base64,bG9nbw==",
    );

    await user.click(screen.getByRole("button", { name: "Custom icon" }));
    expect(onChooseCustomIcon).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("button", { name: "Icon Code" }),
    ).not.toBeInTheDocument();
  });
});
