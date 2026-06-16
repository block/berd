import { afterEach, describe, expect, it } from "vitest";

import { syncStreamdownTableScrollbarSizing } from "./streamdown-table-scrollbar";

interface TableScrollerOptions {
  clientHeight: number;
  clientWidth: number;
  offsetHeight: number;
  scrollWidth: number;
}

function createStreamdownTableScroller({
  clientHeight,
  clientWidth,
  offsetHeight,
  scrollWidth,
}: TableScrollerOptions): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.setAttribute("data-streamdown", "table-wrapper");

  const scrollContainer = document.createElement("div");
  scrollContainer.style.borderTopWidth = "1px";
  scrollContainer.style.borderBottomWidth = "1px";

  const table = document.createElement("table");
  table.setAttribute("data-streamdown", "table");

  scrollContainer.appendChild(table);
  wrapper.appendChild(scrollContainer);
  document.body.appendChild(wrapper);

  Object.defineProperties(scrollContainer, {
    clientHeight: { configurable: true, value: clientHeight },
    clientWidth: { configurable: true, value: clientWidth },
    offsetHeight: { configurable: true, value: offsetHeight },
    scrollWidth: { configurable: true, value: scrollWidth },
  });

  return scrollContainer;
}

describe("syncStreamdownTableScrollbarSizing", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("reserves horizontal scrollbar height for wide generated tables", () => {
    const scrollContainer = createStreamdownTableScroller({
      clientHeight: 24,
      clientWidth: 200,
      offsetHeight: 41,
      scrollWidth: 320,
    });

    syncStreamdownTableScrollbarSizing(document.body);

    expect(
      scrollContainer.style.getPropertyValue(
        "--streamdown-table-scrollbar-block-size",
      ),
    ).toBe("15px");
  });

  it("does not reserve extra height for tables that fit", () => {
    const scrollContainer = createStreamdownTableScroller({
      clientHeight: 24,
      clientWidth: 320,
      offsetHeight: 41,
      scrollWidth: 320,
    });

    syncStreamdownTableScrollbarSizing(document.body);

    expect(
      scrollContainer.style.getPropertyValue(
        "--streamdown-table-scrollbar-block-size",
      ),
    ).toBe("0px");
  });
});
